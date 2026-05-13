import { Connection } from "@authhero/adapter-interfaces";
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
