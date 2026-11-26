import { Context } from "hono";
import {
  Connection,
  DATABASE_CONNECTION_STRATEGY,
  DataAdapters,
  LogTypes,
  Strategy,
  User,
  UserInsert,
} from "@authhero/adapter-interfaces";
import { Bindings, Variables } from "../../types";
import { logMessage } from "../../helpers/logging";
import { isUniqueConstraintError } from "../../errors/is-unique-constraint-error";
import { normalizeEmail } from "../../utils/email";

/** Most `api.users.ensure` calls one action execution may make. */
export const MAX_ENSURED_USERS_PER_EXECUTION = 5;

/**
 * Connection names that collide with built-in provider prefixes. An external
 * connection with one of these names would mint user_ids (`email|…`,
 * `auth0|…`) that real login identities also use. Injected strategies and the
 * tenant's own login connections are added per lookup.
 */
const BUILT_IN_PROVIDER_PREFIXES = new Set(
  [
    ...Object.values(Strategy),
    DATABASE_CONNECTION_STRATEGY,
    "auth2",
    "samlp",
  ].map((name) => name.toLowerCase()),
);

const PROFILE_STRING_FIELDS = [
  "email",
  "phone_number",
  "name",
  "given_name",
  "family_name",
  "nickname",
  "picture",
] as const;

type ProfileStringField = (typeof PROFILE_STRING_FIELDS)[number];

type EnsureProfile = Partial<Record<ProfileStringField, string>> & {
  email_verified?: boolean;
};

type EnsureParams = {
  connection: string;
  id: string;
  profile: EnsureProfile;
  app_metadata?: Record<string, unknown>;
};

type ParseResult =
  | { ok: true; params: EnsureParams }
  | { ok: false; reason: string; connection?: string; id?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEnsureParams(raw: unknown): ParseResult {
  if (!isRecord(raw)) return { ok: false, reason: "invalid_params" };

  const { connection, id, profile, app_metadata } = raw;
  if (typeof connection !== "string" || !connection) {
    return { ok: false, reason: "invalid_params" };
  }
  // The key is kept exactly as given: trimming would map " 42" and "42" to
  // the same user, and `setLinkedTo` is called with the caller's own string.
  if (typeof id !== "string" || !id.trim() || id.includes("|")) {
    return { ok: false, reason: "invalid_id", connection, id };
  }
  if (profile !== undefined && !isRecord(profile)) {
    return { ok: false, reason: "invalid_params", connection, id };
  }
  if (app_metadata !== undefined && !isRecord(app_metadata)) {
    return { ok: false, reason: "invalid_params", connection, id };
  }

  // Keep only known, non-blank profile fields. Anything else (user_id,
  // linked_to, provider, …) is silently dropped so an action can't use the
  // profile to rewrite identity columns.
  const cleanProfile: EnsureProfile = {};
  if (profile) {
    for (const field of PROFILE_STRING_FIELDS) {
      const value = profile[field];
      if (typeof value === "string" && value.trim()) {
        cleanProfile[field] =
          field === "email" ? normalizeEmail(value) : value.trim();
      }
    }
    if (typeof profile.email_verified === "boolean") {
      cleanProfile.email_verified = profile.email_verified;
    }
  }

  return {
    ok: true,
    params: {
      connection,
      id,
      profile: cleanProfile,
      app_metadata,
    },
  };
}

const CONNECTIONS_PAGE_SIZE = 100;
const MAX_CONNECTION_PAGES = 50;

/** Every connection on the tenant: `list` returns one page (50 by default). */
async function listAllConnections(
  data: DataAdapters,
  tenantId: string,
): Promise<Connection[]> {
  const all: Connection[] = [];
  for (let page = 0; page < MAX_CONNECTION_PAGES; page++) {
    const { connections } = await data.connections.list(tenantId, {
      page,
      per_page: CONNECTIONS_PAGE_SIZE,
      include_totals: false,
    });
    all.push(...connections);
    if (connections.length < CONNECTIONS_PAGE_SIZE) break;
  }
  return all;
}

/**
 * Lazily loads the tenant's connections once per execution. Used to resolve
 * the connection `ensure` writes to and to tell whether a user is an anchor
 * (a primary whose connection is an external connection) without a lookup
 * per call.
 *
 * `injectedStrategies` are the names of strategies supplied through
 * `env.STRATEGIES`: a login connection using one stores its users under that
 * name, so an external connection must not reuse it.
 */
export function createExternalConnectionLookup(
  data: DataAdapters,
  tenantId: string,
  injectedStrategies: Iterable<string> = [],
) {
  let pending: Promise<{
    external: Connection[];
    reserved: Set<string>;
  }> | null = null;
  const load = () => {
    if (!pending) {
      pending = listAllConnections(data, tenantId).then((connections) => {
        const reserved = new Set(BUILT_IN_PROVIDER_PREFIXES);
        for (const name of injectedStrategies) reserved.add(name.toLowerCase());
        for (const c of connections) {
          if (c.strategy !== Strategy.EXTERNAL) {
            reserved.add(c.strategy.toLowerCase());
          }
        }
        return {
          external: connections.filter((c) => c.strategy === Strategy.EXTERNAL),
          reserved,
        };
      });
    }
    return pending;
  };

  return {
    /**
     * The external connection named `name` if actions may create users in it:
     * opted in with `allow_action_users`, and not named like a prefix that
     * login identities use.
     */
    getActionUsersConnection: async (name: string) => {
      const { external, reserved } = await load();
      const connection = external.find((c) => c.name === name);
      if (
        !connection ||
        connection.options?.allow_action_users !== true ||
        reserved.has(connection.name.toLowerCase())
      ) {
        return undefined;
      }
      return connection;
    },
    /** True when `user` lives in one of the tenant's external connections. */
    isExternalUser: async (user: Pick<User, "connection" | "provider">) => {
      const { external } = await load();
      return external.some(
        (c) => c.name === user.connection && c.name === user.provider,
      );
    },
  };
}

export type ExternalConnectionLookup = ReturnType<
  typeof createExternalConnectionLookup
>;

/**
 * Builds the host implementation of `api.users.ensure` (issue #1802).
 *
 * The isolate only records the call; this runs when it is replayed. It
 * creates `<connection>|<id>` if missing, otherwise merges the profile and
 * `app_metadata` into it. Every refusal logs `FAILED_HOOK` and writes nothing.
 *
 * Writes go through the transaction's adapters, which are undecorated: no
 * registration or update hooks, no built-in email linking (which would demote
 * a new anchor under an older same-email user), and no post-registration
 * webhook or outbox event — the user is a record, not a signup.
 */
export function createActionUsersApi(params: {
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>;
  data: DataAdapters;
  tenantId: string;
  triggerId: string;
  externalConnections: ExternalConnectionLookup;
}) {
  const { ctx, data, tenantId, triggerId, externalConnections } = params;
  const ensuredUserIds = new Set<string>();
  let calls = 0;

  const refuse = (
    reason: string,
    description: string,
    extra: Record<string, unknown> = {},
  ) => {
    logMessage(ctx, tenantId, {
      type: LogTypes.FAILED_HOOK,
      description,
      details: { trigger_id: triggerId, reason, ...extra },
    });
  };

  const ensure = async (raw: unknown): Promise<void> => {
    calls++;
    if (calls > MAX_ENSURED_USERS_PER_EXECUTION) {
      refuse(
        "too_many_users",
        `${triggerId} action called users.ensure more than ${MAX_ENSURED_USERS_PER_EXECUTION} times`,
      );
      return;
    }

    const parsed = parseEnsureParams(raw);
    if (!parsed.ok) {
      refuse(
        parsed.reason,
        `${triggerId} action passed invalid arguments to users.ensure`,
        { connection: parsed.connection },
      );
      return;
    }
    const {
      connection: connectionName,
      id,
      profile,
      app_metadata,
    } = parsed.params;

    const connection =
      await externalConnections.getActionUsersConnection(connectionName);
    if (!connection) {
      refuse(
        "connection_not_allowed",
        `${triggerId} action tried to ensure a user in connection ${connectionName}, which does not allow action users`,
        { connection: connectionName },
      );
      return;
    }

    const userId = `${connectionName}|${id}`;

    /** False when the row disappeared between the read and the write. */
    const merge = async (
      users: DataAdapters["users"],
      existing: User,
    ): Promise<boolean> => {
      const updates: Partial<User> = { ...profile };
      // A verified flag belongs to an address. When the address changes and
      // the action doesn't vouch for the new one, it starts unverified.
      if (
        profile.email !== undefined &&
        profile.email !== existing.email &&
        profile.email_verified === undefined
      ) {
        updates.email_verified = false;
      }
      if (app_metadata) {
        updates.app_metadata = {
          ...(existing.app_metadata ?? {}),
          ...app_metadata,
        };
      }
      if (Object.keys(updates).length === 0) return true;
      return users.update(tenantId, userId, updates);
    };

    const upsert = () =>
      data.transaction(async (trx) => {
        const existing = await trx.users.get(tenantId, userId);
        // An update that matched no row (deleted in between) recreates it.
        if (existing && (await merge(trx.users, existing))) {
          return "updated" as const;
        }
        const now = new Date().toISOString();
        const insert: UserInsert = {
          ...profile,
          email_verified: profile.email_verified ?? false,
          user_id: userId,
          provider: connectionName,
          connection: connectionName,
          is_social: false,
          app_metadata: app_metadata ?? {},
          user_metadata: {},
          // Never a signup: nothing should treat it as a pending registration.
          registration_completed_at: now,
        };
        await trx.users.rawCreate(tenantId, insert);
        return "created" as const;
      });

    let outcome: "created" | "updated";
    try {
      outcome = await upsert();
    } catch (err) {
      // A concurrent ensure created the row between our read and insert;
      // retry once, which now takes the merge branch.
      if (!isUniqueConstraintError(err)) throw err;
      outcome = await upsert();
    }

    ensuredUserIds.add(userId);
    logMessage(ctx, tenantId, {
      type: LogTypes.SUCCESS_HOOK,
      description: `${triggerId} action ${outcome} user ${userId}`,
      userId,
      details: {
        trigger_id: triggerId,
        operation: "users.ensure",
        outcome,
        connection: connectionName,
      },
    });
  };

  return {
    api: { users: { ensure } },
    /** user_ids that `ensure` created or updated during this execution. */
    ensuredUserIds,
  };
}
