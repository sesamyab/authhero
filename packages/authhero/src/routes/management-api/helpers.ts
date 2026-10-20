import { HTTPException } from "hono/http-exception";
import { z } from "@hono/zod-openapi";
import { totalsSchema } from "@authhero/adapter-interfaces";

/**
 * Returns the tenant id resolved by tenantMiddleware, or throws the
 * management API's standard 400 when the request carries no tenant (no
 * `tenant-id` header, no tenant subdomain/custom domain, and no
 * single-tenant fallback).
 *
 * Structurally typed on purpose: handler contexts are narrowed per-route by
 * `defineRoute`, so accepting the full hono `Context` generic here would
 * force every call site to line up generics for a helper that only reads
 * one variable.
 */
export function requireTenantId(ctx: { var: { tenant_id?: string } }): string {
  const tenantId = ctx.var.tenant_id;
  if (!tenantId) {
    throw new HTTPException(400, {
      message: "tenant-id header is required",
    });
  }
  return tenantId;
}

/**
 * Schema factory for the `include_totals` list-response shape:
 * `{ start, limit, length, total?, next?, <resource>: [...] }`.
 *
 * `withTotals({ roles: z.array(roleSchema) })` replaces the
 * `totalsSchema.extend({ roles: z.array(roleSchema) })` pattern repeated
 * across the management-api modules.
 */
export function withTotals<T extends z.ZodRawShape>(items: T) {
  return totalsSchema.extend(items);
}

/**
 * Schema factory for the checkpoint (`from`/`take`) list-response shape:
 * `{ <resource>: [...], next? }`. `next` is an opaque cursor, absent on the
 * last page.
 */
export function withNext<T extends z.ZodRawShape>(items: T) {
  return z.object({
    ...items,
    next: z.string().optional().openapi({
      description: "Opaque cursor for the next page; absent on the last page.",
    }),
  });
}

/**
 * Builds the Auth0 `include_totals` envelope from an adapter list result.
 *
 * Adapters report the overall match count as `length` (the offset-list
 * contract). Auth0's wire format differs: `length` is the number of items on
 * the returned page and `total` is the overall count, so the two are
 * remapped here. A result that already carries `total` keeps it. Checkpoint
 * (`from`/`take`) responses are built by the callers and never come through
 * this helper.
 */
export function withTotalsEnvelope<T extends { length: number }>(
  result: T,
  items: readonly unknown[],
): T & { length: number; total: number } {
  const total =
    (result as { total?: number }).total ??
    (result as { length: number }).length;
  return { ...result, length: items.length, total };
}

/**
 * Picks the list-response body for the `include_totals` branch every list
 * handler repeats: the Auth0 totals envelope (`start`, `limit`, `length`,
 * `total`) when `include_totals` is set, otherwise the bare item array under
 * `key`.
 *
 * The caller keeps its own `ctx.json(...)` so hono's per-route response
 * typing still applies.
 */
export function listResponse<T extends { length: number }, K extends keyof T>(
  include_totals: boolean | undefined,
  result: T,
  key: K,
): (T & { length: number; total: number }) | T[K] {
  return include_totals
    ? withTotalsEnvelope(result, result[key] as unknown as readonly unknown[])
    : result[key];
}
