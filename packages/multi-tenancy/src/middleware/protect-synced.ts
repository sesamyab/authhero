import { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { isSyncedRowId, type DataAdapters } from "authhero";
import { getRequestData } from "./request-data";

/**
 * Bindings for the protect system middleware
 */
interface ProtectSystemBindings {
  data: DataAdapters;
}

/**
 * Variables expected to be set by earlier middleware
 */
interface ProtectSystemVariables {
  tenant_id?: string;
  data?: DataAdapters;
}

/**
 * Entity types that support the is_system field
 */
type SystemEntityType = "resource_server" | "role" | "connection";

/**
 * Information about an entity parsed from the request path
 */
interface EntityInfo {
  type: SystemEntityType;
  id: string;
}

/**
 * Parse entity type and ID from a request path
 *
 * @param path - The request path
 * @returns Entity information or null if not a recognized entity path
 */
function parseEntityFromPath(path: string): EntityInfo | null {
  const patterns: { pattern: RegExp; type: SystemEntityType }[] = [
    {
      pattern: /\/api\/v2\/resource-servers\/([^/]+)$/,
      type: "resource_server",
    },
    { pattern: /\/api\/v2\/roles\/([^/]+)$/, type: "role" },
    { pattern: /\/api\/v2\/connections\/([^/]+)$/, type: "connection" },
  ];

  for (const { pattern, type } of patterns) {
    const match = path.match(pattern);
    if (match && match[1]) {
      return { type, id: match[1] };
    }
  }

  return null;
}

/**
 * Check if an entity is a system entity from the control plane
 *
 * @param adapters - Data adapters
 * @param tenantId - The tenant ID
 * @param entityInfo - Entity type and ID
 * @returns true if the entity is a system entity
 */
async function isSystemEntity(
  adapters: DataAdapters,
  tenantId: string,
  entityInfo: EntityInfo,
): Promise<boolean> {
  try {
    switch (entityInfo.type) {
      case "resource_server": {
        const rs = await adapters.resourceServers.get(tenantId, entityInfo.id);
        return rs?.is_system === true;
      }
      case "role": {
        const role = await adapters.roles.get(tenantId, entityInfo.id);
        return role?.is_system === true;
      }
      case "connection": {
        const conn = await adapters.connections.get(tenantId, entityInfo.id);
        return conn?.is_system === true;
      }
      default:
        return false;
    }
  } catch {
    // If we can't fetch the entity, assume it's not a system entity
    return false;
  }
}

/**
 * Get a human-readable entity type name
 *
 * @param type - The entity type
 * @returns Human-readable name
 */
function getEntityTypeName(type: SystemEntityType): string {
  const names: Record<SystemEntityType, string> = {
    resource_server: "resource server",
    role: "role",
    connection: "connection",
  };
  return names[type];
}

type SyncedEntityType =
  | "connection"
  | "resource_server"
  | "action"
  | "hook"
  | "hook_code";

interface SyncedEntityInfo {
  type: SyncedEntityType;
  id: string;
}

/** Entities a config sync copies into a tenant, addressed by id. */
function parseSyncedEntityFromPath(path: string): SyncedEntityInfo | null {
  const patterns: { pattern: RegExp; type: SyncedEntityType }[] = [
    { pattern: /\/api\/v2\/connections\/([^/]+)$/, type: "connection" },
    {
      pattern: /\/api\/v2\/resource-servers\/([^/]+)$/,
      type: "resource_server",
    },
    { pattern: /\/api\/v2\/actions\/actions\/([^/]+)$/, type: "action" },
    { pattern: /\/api\/v2\/hooks\/([^/]+)$/, type: "hook" },
    { pattern: /\/api\/v2\/hook-code\/([^/]+)$/, type: "hook_code" },
  ];
  for (const { pattern, type } of patterns) {
    const match = path.match(pattern);
    if (match?.[1]) return { type, id: match[1] };
  }
  return null;
}

type LockableRow = {
  scope?: string | null;
  override?: string | null;
  enforce?: boolean | null;
} & Record<string, unknown>;

async function readSyncedRow(
  adapters: DataAdapters,
  tenantId: string,
  info: SyncedEntityInfo,
): Promise<LockableRow | null> {
  try {
    switch (info.type) {
      case "connection":
        return (await adapters.connections.get(tenantId, info.id)) as never;
      case "resource_server":
        return (await adapters.resourceServers.get(tenantId, info.id)) as never;
      case "action":
        return (await adapters.actions.get(tenantId, info.id)) as never;
      case "hook":
        return (await adapters.hooks.get(tenantId, info.id)) as never;
      case "hook_code":
        return (await adapters.hookCode.get(tenantId, info.id)) as never;
    }
  } catch {
    return null;
  }
}

/** Top-level fields a child may change when the parent's `override` is `secrets`. */
const SECRET_FIELDS: Record<SyncedEntityType, string[]> = {
  connection: ["options"],
  resource_server: ["signing_secret"],
  action: ["secrets"],
  hook: [],
  hook_code: [],
};

/**
 * Connection options a child may change under `override: "secrets"`: exactly
 * the values the encrypted data adapter treats as secrets. A pattern match is
 * too loose (it would let `token_endpoint` through), so this is an allowlist.
 */
const SECRET_OPTIONS = new Set(["client_secret", "app_secret", "twilio_token"]);

/** `configuration` may differ only in its `client_secret`. */
function onlySecretConfigurationChanged(next: unknown, current: unknown) {
  const strip = (value: unknown) => {
    const { client_secret: _secret, ...rest } = (value ?? {}) as Record<
      string,
      unknown
    >;
    return rest;
  };
  return same(strip(next), strip(current));
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

function forbidden(info: SyncedEntityInfo, why: string): HTTPException {
  return new HTTPException(403, {
    message: `This ${info.type.replace("_", " ")} is synced from a parent tenant and ${why}. Make changes in the parent tenant instead.`,
  });
}

/**
 * Enforces the publishing properties of a row a config sync copied into the
 * tenant: `override` limits what the child may edit, `enforce` stops it from
 * deleting or disabling the row, and nobody may change the properties
 * themselves from the child. Rows the tenant owns are not touched.
 */
async function enforceSyncedLocks(
  ctx: {
    req: { method: string; raw: Request };
  } & Parameters<typeof getRequestData>[0],
  tenantId: string,
  info: SyncedEntityInfo,
): Promise<void> {
  const row = await readSyncedRow(getRequestData(ctx), tenantId, info);
  // Hidden (platform) or missing rows are the route's 404 to give.
  if (!row) return;

  // Code copied for a hook has no publishing properties of its own: it is
  // never edited or removed from the child.
  if (info.type === "hook_code") {
    throw forbidden(info, "cannot be modified");
  }

  if (ctx.req.method === "DELETE") {
    if (row.enforce === true) throw forbidden(info, "cannot be deleted");
    return;
  }

  const override = row.override ?? "fields";
  if (override === "none") throw forbidden(info, "cannot be edited");

  let body: Record<string, unknown> = {};
  try {
    const parsed = await ctx.req.raw.clone().json();
    if (parsed && typeof parsed === "object") {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    // No JSON body: nothing to compare.
  }

  // The admin UI sends the whole record, so unchanged values are fine.
  for (const key of ["scope", "override", "enforce"] as const) {
    if (key in body && !same(body[key] ?? null, row[key] ?? null)) {
      throw forbidden(info, `has a locked ${key}`);
    }
  }

  if (row.enforce === true && body.enabled === false) {
    throw forbidden(info, "cannot be disabled");
  }

  if (override === "secrets") {
    const allowed = SECRET_FIELDS[info.type];
    for (const [key, value] of Object.entries(body)) {
      if (["scope", "override", "enforce"].includes(key)) continue;
      if (same(value, row[key])) continue;
      if (!allowed.includes(key)) {
        throw forbidden(
          info,
          `only allows its secrets to be changed (not ${key})`,
        );
      }
      // Within `options`, only the secret values may differ.
      if (key === "options" && value && typeof value === "object") {
        const current = (row.options ?? {}) as Record<string, unknown>;
        for (const [option, optionValue] of Object.entries(value)) {
          if (same(optionValue, current[option])) continue;
          // `*_hint` options are response-only masked previews of a secret
          // that a whole-record PATCH echoes back; they are never stored.
          if (option.endsWith("_hint")) continue;
          const allowedChange =
            SECRET_OPTIONS.has(option) ||
            (option === "configuration" &&
              onlySecretConfigurationChanged(optionValue, current[option]));
          if (!allowedChange) {
            throw forbidden(
              info,
              `only allows its secrets to be changed (not options.${option})`,
            );
          }
        }
      }
    }
  }
}

/**
 * Creates middleware to protect system resources from modification.
 *
 * This middleware intercepts write operations (PATCH, PUT, DELETE) on
 * entities that are marked as system entities from the control plane and returns a 403
 * error if modification is attempted.
 *
 * System resources can only be modified in the control plane, and changes
 * will be propagated to child tenants automatically.
 *
 * @returns Hono middleware handler
 *
 * @example
 * ```typescript
 * import { createProtectSyncedMiddleware } from "@authhero/multi-tenancy";
 *
 * // Apply to management API routes
 * app.use("/api/v2/*", createProtectSyncedMiddleware());
 * ```
 */
export function createProtectSyncedMiddleware(): MiddlewareHandler<{
  Bindings: ProtectSystemBindings;
  Variables: ProtectSystemVariables;
}> {
  return async (ctx, next) => {
    // Only check write operations
    if (!["PATCH", "PUT", "DELETE"].includes(ctx.req.method)) {
      return next();
    }

    const entityInfo = parseEntityFromPath(ctx.req.path);
    const syncedInfo = parseSyncedEntityFromPath(ctx.req.path);
    if (!entityInfo && !syncedInfo) {
      return next();
    }

    // Get tenant ID from context variable or header
    const tenantId =
      ctx.var.tenant_id ||
      ctx.req.header("x-tenant-id") ||
      ctx.req.header("tenant-id");

    if (!tenantId) {
      return next();
    }

    if (entityInfo) {
      const isSystem = await isSystemEntity(
        getRequestData(ctx),
        tenantId,
        entityInfo,
      );
      if (isSystem) {
        throw new HTTPException(403, {
          message: `This ${getEntityTypeName(entityInfo.type)} is a system resource and cannot be modified. Make changes in the control plane instead.`,
        });
      }
    }

    if (syncedInfo && isSyncedRowId(syncedInfo.id)) {
      await enforceSyncedLocks(ctx, tenantId, syncedInfo);
    }

    return next();
  };
}
