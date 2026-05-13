// @ts-nocheck - Migration uses untyped JSON columns
import { Kysely } from "kysely";
import { Database } from "../../src/db";

/**
 * Collapse the `strategy: "auth0"` source connection into the DB connection.
 *
 * Previously two connections cooperated for upstream-Auth0 migration:
 *   1. A `strategy: "auth0"` connection holding upstream creds
 *      (token_endpoint, userinfo_endpoint, client_id, client_secret) plus an
 *      `import_mode` flag that gated refresh-token proxying.
 *   2. A DB connection (`Username-Password-Authentication`) with its own
 *      `import_mode` flag that gated password-realm capture.
 *
 * The new shape is Auth0-faithful: the DB connection holds everything in
 * `options.configuration` (the upstream creds) and `options.import_mode`
 * (when true, unknown-user/unknown-password logins fall through to upstream).
 * The refresh-token proxy is removed in this PR — re-mint replacement tracked
 * separately.
 *
 * Backfill: for every tenant that has exactly one `strategy: "auth0"`
 * connection AND exactly one `Username-Password-Authentication` connection,
 * merge the upstream-cred fields into the DB connection's
 * `options.configuration`, then delete the auth0 row. Tenants with multiple
 * DB connections are left untouched and logged — operators must manually
 * decide which connection inherits the migration credentials.
 */

const UPSTREAM_FIELDS = [
  "token_endpoint",
  "userinfo_endpoint",
  "client_id",
  "client_secret",
] as const;

function parseOptions(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function up(db: Kysely<Database>): Promise<void> {
  const auth0Connections = await db
    .selectFrom("connections")
    .select(["id", "tenant_id", "options"])
    .where("strategy", "=", "auth0")
    .execute();

  for (const source of auth0Connections) {
    const dbConnections = await db
      .selectFrom("connections")
      .select(["id", "name", "options"])
      .where("tenant_id", "=", source.tenant_id)
      .where("strategy", "=", "Username-Password-Authentication")
      .execute();

    if (dbConnections.length === 0) {
      console.warn(
        `[collapse_auth0_source] tenant=${source.tenant_id}: auth0 connection ${source.id} has no DB connection to merge into; deleting it`,
      );
      await db
        .deleteFrom("connections")
        .where("tenant_id", "=", source.tenant_id)
        .where("id", "=", source.id)
        .execute();
      continue;
    }

    if (dbConnections.length > 1) {
      console.warn(
        `[collapse_auth0_source] tenant=${source.tenant_id}: ${dbConnections.length} DB connections found; skipping merge — resolve manually before next deploy`,
      );
      continue;
    }

    const sourceOptions = parseOptions(source.options);
    const upstream: Record<string, unknown> = {};
    for (const key of UPSTREAM_FIELDS) {
      if (typeof sourceOptions[key] === "string") {
        upstream[key] = sourceOptions[key];
      }
    }

    const target = dbConnections[0]!;
    const targetOptions = parseOptions(target.options);
    const existingConfig =
      targetOptions.configuration &&
      typeof targetOptions.configuration === "object"
        ? (targetOptions.configuration as Record<string, unknown>)
        : {};
    targetOptions.configuration = { ...existingConfig, ...upstream };

    await db
      .updateTable("connections")
      .set({ options: JSON.stringify(targetOptions) })
      .where("tenant_id", "=", source.tenant_id)
      .where("id", "=", target.id)
      .execute();

    await db
      .deleteFrom("connections")
      .where("tenant_id", "=", source.tenant_id)
      .where("id", "=", source.id)
      .execute();
  }
}

export async function down(): Promise<void> {
  // Irreversible: the source `strategy: "auth0"` row is deleted in `up`. The
  // upstream credentials remain on the DB connection's options.configuration
  // and could be split back out manually if ever needed.
}
