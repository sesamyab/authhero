import { Connection, Strategy } from "@authhero/adapter-interfaces";
import { Context } from "hono";
import { Bindings, Variables } from "../types";

async function listConnections(
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>,
  tenantId: string,
): Promise<Connection[]> {
  const perPage = 100;
  const all: Connection[] = [];
  for (let page = 0; ; page++) {
    const { connections } = await ctx.env.data.connections.list(tenantId, {
      page,
      per_page: perPage,
      include_totals: false,
    });
    all.push(...connections);
    if (connections.length < perPage) break;
  }
  return all;
}

/**
 * Returns the singleton `strategy: "auth0"` connection for a tenant, or null
 * if migration has not been configured. Used by the password and refresh-token
 * flows to find the upstream Auth0 credentials when lazy-migrating users.
 *
 * A tenant is expected to have at most one such connection; if multiple are
 * present we use the first to keep behaviour deterministic.
 */
export async function getAuth0SourceConnection(
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>,
  tenantId: string,
): Promise<Connection | null> {
  const connections = await listConnections(ctx, tenantId);
  return (
    connections.find((c) => c.strategy === Strategy.AUTH0) ?? null
  );
}

/**
 * Returns the first DB-strategy connection flagged `import_mode: true` for a
 * tenant. Used by the password flow to pick a realm name when the user does
 * not yet exist locally, so the upstream ROPG call can target the right
 * upstream database connection.
 */
export async function findImportModeDbConnection(
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>,
  tenantId: string,
): Promise<Connection | null> {
  const connections = await listConnections(ctx, tenantId);
  return (
    connections.find(
      (c) =>
        c.strategy === Strategy.USERNAME_PASSWORD &&
        c.options?.import_mode === true,
    ) ?? null
  );
}

/**
 * Look up a connection by its `name`. Used to resolve the connection an
 * existing user is registered under so we can read its options.
 */
export async function findConnectionByName(
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>,
  tenantId: string,
  name: string,
): Promise<Connection | null> {
  const connections = await listConnections(ctx, tenantId);
  return connections.find((c) => c.name === name) ?? null;
}
