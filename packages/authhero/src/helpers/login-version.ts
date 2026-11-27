export type LoginRoutePrefix = "/u" | "/u2";

type ClientLike = {
  client_metadata?: Record<string, unknown> | null;
  tenant?: { flags?: { universal_login_version?: string } | null } | null;
};

/**
 * Picks the universal login a client uses.
 *
 * A client can override the tenant with `client_metadata.universal_login_version`
 * ("2" → /u2, "1" → /u). Without an override the tenant flag
 * `flags.universal_login_version` decides ("2" → /u2, "1" or unset → /u).
 */
export function resolveLoginRoutePrefix(client: ClientLike): LoginRoutePrefix {
  const override = client.client_metadata?.universal_login_version;
  if (override === "2") return "/u2";
  if (override === "1") return "/u";
  return client.tenant?.flags?.universal_login_version === "2" ? "/u2" : "/u";
}
