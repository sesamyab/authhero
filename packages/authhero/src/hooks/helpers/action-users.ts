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
 * `auth0|…`) that real login identities also use.
 */
const RESERVED_CONNECTION_NAMES = new Set(
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
      id: id.trim(),
      profile: cleanProfile,
      app_metadata,
    },
  };
}

/** True for a connection actions may create users in. */
export function isActionUsersConnection(connection: Connection): boolean {
  return (
    connection.strategy === Strategy.EXTERNAL &&
    connection.options?.allow_action_users === true &&
    !RESERVED_CONNECTION_NAMES.has(connection.name.toLowerCase())
  );
}

/**
 * Lazily loads the tenant's `external` connections once per execution. Used
 * to tell whether a user is an anchor (a primary whose connection is an
 * external connection) without a lookup per call.
 */
export function createExternalConnectionLookup(
  data: DataAdapters,
  tenantId: string,
) {
  let pending: Promise<Connection[]> | null = null;
  const load = () => {
    if (!pending) {
      pending = data.connections
        .list(tenantId)
        .then(({ connections }) =>
          connections.filter((c) => c.strategy === Strategy.EXTERNAL),
        );
    }
    return pending;
  };

  return {
    getByName: async (name: string) =>
      (await load()).find((c) => c.name === name),
    /** True when `user` lives in one of the tenant's external connections. */
    isExternalUser: async (user: Pick<User, "connection" | "provider">) => {
      const connections = await load();
      return connections.some(
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

    const connection = await externalConnections.getByName(connectionName);
    if (!connection || !isActionUsersConnection(connection)) {
      refuse(
        "connection_not_allowed",
        `${triggerId} action tried to ensure a user in connection ${connectionName}, which does not allow action users`,
        { connection: connectionName },
      );
      return;
    }

    const userId = `${connectionName}|${id}`;

    const merge = async (
      users: DataAdapters["users"],
      existing: User,
    ): Promise<void> => {
      const updates: Partial<User> = { ...profile };
      if (app_metadata) {
        updates.app_metadata = {
          ...(existing.app_metadata ?? {}),
          ...app_metadata,
        };
      }
      if (Object.keys(updates).length > 0) {
        await users.update(tenantId, userId, updates);
      }
    };

    const upsert = () =>
      data.transaction(async (trx) => {
        const existing = await trx.users.get(tenantId, userId);
        if (existing) {
          await merge(trx.users, existing);
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
