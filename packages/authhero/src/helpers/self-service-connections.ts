import type {
  Connection,
  ConnectionSelfService,
  ConnectionsAdapter,
  User,
} from "@authhero/adapter-interfaces";

/**
 * Self-Service SSO (#1763) lets an outside admin configure a connection's
 * identity provider through a ticket. Whoever controls that identity provider
 * controls what it asserts, including `email_verified: true` for any address.
 * Email-based account linking trusts `email_verified`, so without a guard such
 * a connection could take over existing accounts, or capture accounts created
 * later with the same email.
 *
 * The guard: for a self-service connection, an email is trusted only when its
 * domain is verified for that connection.
 *  - `email_verified` is forced to `false` outside verified domains
 *    ({@link isUntrustedSelfServiceEmail});
 *  - a user of such a connection whose email domain is not verified is never
 *    picked as an email-linking target ({@link filterTrustedLinkTargets}).
 */

/** The connection without its internal Self-Service SSO state. */
export function withoutSelfService<T extends Pick<Connection, "self_service">>(
  connection: T,
): Omit<T, "self_service"> {
  const { self_service: _, ...rest } = connection;
  return rest;
}

/** The lowercased domain of an email address, or `undefined`. */
export function emailDomain(email: string | undefined): string | undefined {
  if (!email) return undefined;
  const at = email.lastIndexOf("@");
  if (at < 0) return undefined;
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase();
  return domain || undefined;
}

/**
 * True when the email's domain is verified for the self-service connection.
 * Exact match: verifying `example.com` does not cover `sub.example.com`.
 */
export function isEmailDomainVerified(
  selfService: ConnectionSelfService,
  email: string | undefined,
): boolean {
  const domain = emailDomain(email);
  if (!domain) return false;
  return (selfService.domains ?? []).some(
    (d) => d.status === "verified" && d.domain.trim().toLowerCase() === domain,
  );
}

/**
 * True when the connection is a self-service connection that does not vouch
 * for this email (its domain is not verified for it), i.e. the guard has to
 * force `email_verified` to `false`. Always false for an ordinary connection,
 * whose assertions are stored as they come.
 */
export function isUntrustedSelfServiceEmail(
  selfService: ConnectionSelfService | null | undefined,
  email: string | undefined,
): boolean {
  return !!selfService && !isEmailDomainVerified(selfService, email);
}

/** The tenant's self-service connections, keyed by connection name. */
async function listSelfServiceConnections(
  connections: Pick<ConnectionsAdapter, "list">,
  tenantId: string,
): Promise<Map<string, ConnectionSelfService>> {
  const byName = new Map<string, ConnectionSelfService>();
  const perPage = 100;
  for (let page = 0; ; page++) {
    const result = await connections.list(tenantId, {
      page,
      per_page: perPage,
    });
    for (const connection of result.connections) {
      if (connection.self_service) {
        byName.set(connection.name, connection.self_service);
      }
    }
    if (result.connections.length < perPage) break;
  }
  return byName;
}

/**
 * Drops the candidates that must never become an email-linking target: users
 * of a self-service connection whose email domain is not verified for it.
 * Their identity provider could assert someone else's email, so linking a new
 * account into them would hand that account to whoever runs the provider.
 *
 * Reads the tenant's connections only when there are candidates, so the
 * common path (no existing user with the email) costs nothing.
 */
export async function filterTrustedLinkTargets(
  connections: Pick<ConnectionsAdapter, "list">,
  tenantId: string,
  candidates: User[],
): Promise<User[]> {
  if (candidates.length === 0) return candidates;
  const selfService = await listSelfServiceConnections(connections, tenantId);
  if (selfService.size === 0) return candidates;
  return candidates.filter((candidate) => {
    const config = candidate.connection
      ? selfService.get(candidate.connection)
      : undefined;
    return !isUntrustedSelfServiceEmail(config, candidate.email);
  });
}
