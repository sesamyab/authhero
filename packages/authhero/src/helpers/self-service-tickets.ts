import type { Context } from "hono";
import { encodeBase64Url, encodeHex } from "@authhero/adapter-interfaces";
import type { Bindings, Variables } from "../types";
import { getIssuer } from "../variables";

/**
 * Shared helpers for self-service tickets: the bearer links that let an
 * outside party set something up without an account. Used by Self-Service
 * SSO tickets (#1763) and developer app invites and edit links (#1776).
 *
 * A ticket id is 32 random bytes, base64url-encoded, returned once inside the
 * ticket URL and stored only as its hex SHA-256 hash.
 */

/** A new ticket id: 32 random bytes, base64url (43 characters). */
export function generateTicketId(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The stored form of a ticket id: hex SHA-256. */
export async function hashTicketId(ticketId: string): Promise<string> {
  return encodeHex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ticketId)),
  );
}

/** Developer app setup page (invite and edit links), on the tenant's domain. */
export const APP_TICKET_PATH = "u2/self-service/app";

/** Default and maximum lifetime of app invite and edit links. */
export const APP_TICKET_DEFAULT_TTL_SEC = 7 * 24 * 60 * 60;
export const APP_TICKET_MAX_TTL_SEC = 30 * 24 * 60 * 60;

/** The query parameter carrying a ticket id in a ticket URL. */
export const TICKET_PARAM = "ticket";

/**
 * The ticket URL for `path` on the tenant's login domain. On the shared
 * issuer host nothing else identifies the tenant, so `tenant_id` is added.
 */
export function buildTicketUrl(
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>,
  path: string,
  ticketId: string,
  tenantId: string,
): string {
  const url = new URL(path, getIssuer(ctx.env, ctx.var.custom_domain));
  url.searchParams.set(TICKET_PARAM, ticketId);
  if (!ctx.var.custom_domain) {
    url.searchParams.set("tenant_id", tenantId);
  }
  return url.toString();
}

const REDACTED = "[redacted]";

/**
 * A logged query record with any ticket id replaced: a log reader must never
 * get a usable ticket.
 */
export function redactTicketQuery<T>(
  query: Record<string, T>,
): Record<string, T | string> {
  if (!(TICKET_PARAM in query)) return query;
  return { ...query, [TICKET_PARAM]: REDACTED };
}
