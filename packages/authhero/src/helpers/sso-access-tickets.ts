import { encodeBase64Url } from "@authhero/adapter-interfaces";

/**
 * Self-Service SSO access tickets (#1763). The ticket id is the bearer value
 * in the ticket URL: random, returned once, and stored only as its hash.
 */

/** Default and maximum ticket lifetime. Auth0's default is 5 days. */
export const SSO_TICKET_DEFAULT_TTL_SEC = 432000;
export const SSO_TICKET_MAX_TTL_SEC = 30 * 24 * 60 * 60;

/** A new ticket id: 32 random bytes, base64url (43 characters). */
export function generateSsoTicketId(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The stored form of a ticket id: hex SHA-256. */
export async function hashSsoTicketId(ticketId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(ticketId),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

/** The setup assistant's path on the tenant's own domain. */
export const SSO_TICKET_PATH = "u2/self-service";
