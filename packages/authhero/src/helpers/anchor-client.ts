import type { Context } from "hono";
import type { Client, Tenant } from "@authhero/adapter-interfaces";
import type { Bindings, Variables } from "../types";
import { isInteractiveClient } from "./provision-tenant-clients";

/**
 * The client a tenant-level browser flow (the /connect/start consent, the
 * developer app setup page) anchors its login session to. The session is only
 * used to carry state through u2 screens; the anchor client_id is never
 * traversed in an OAuth flow. Prefers the tenant's `default_client_id`
 * (analogous to Auth0's Default App) so branding stays deterministic, and
 * falls back to the first *interactive* client — never an M2M client, which
 * can't render a screen. Returns null when the tenant has neither.
 */
export async function resolveAnchorClient(
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>,
  tenant: Tenant,
): Promise<Client | null> {
  let anchorClient = tenant.default_client_id
    ? await ctx.env.data.clients.get(tenant.id, tenant.default_client_id)
    : null;
  if (!anchorClient) {
    // Page through the tenant's clients — the list adapter defaults to the
    // first 50 rows, so an interactive client could sit on a later page.
    const perPage = 100;
    for (let page = 0; !anchorClient; page++) {
      const { clients } = await ctx.env.data.clients.list(tenant.id, {
        page,
        per_page: perPage,
      });
      anchorClient = clients.find(isInteractiveClient) ?? null;
      if (clients.length < perPage) {
        break;
      }
    }
  }
  return anchorClient;
}
