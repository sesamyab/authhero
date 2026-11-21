import {
  Connection,
  ConnectionsAdapter,
  Strategy,
  User,
  isDatabaseConnectionStrategy,
} from "@authhero/adapter-interfaces";

/**
 * Scopes a database-user lookup to one database connection (#1702).
 *
 * Every database connection stores its users under the same `auth0` (or
 * legacy `auth2`) provider, so `email:x provider:auth0` cannot tell two
 * database connections apart. A scope narrows the provider-matched rows to
 * the ones that belong to `name`.
 *
 * A row belongs to `name` when its `connection` is `name`, or when its
 * `connection` names no database connection in the tenant at all. The second
 * case covers legacy rows written with a literal instead of the connection's
 * real name (`Username-Password-Authentication` on a tenant whose connection
 * is called something else, `auth0`, `auth2`, or nothing). Those rows can't be
 * attributed to one connection, so they stay visible to every scope, exactly
 * as they are without one. Rows that do name another database connection of
 * the tenant are hidden.
 */
export interface DatabaseConnectionScope {
  /** The database connection the lookup targets. */
  name: string;
  /** Names of every database connection in the tenant, `name` included. */
  databaseConnectionNames: ReadonlySet<string>;
}

/** True when `user` belongs to the scoped connection. No scope matches all. */
export function isUserInConnectionScope(
  user: { connection?: string },
  scope: DatabaseConnectionScope | undefined,
): boolean {
  if (!scope || !user.connection) return true;
  if (user.connection === scope.name) return true;
  return !scope.databaseConnectionNames.has(user.connection);
}

/**
 * Order rows so an exact connection match comes before an unattributed legacy
 * row. Only relevant once one identifier can exist in several connections.
 */
export function compareByConnectionScope(
  scope: DatabaseConnectionScope,
): (a: Pick<User, "connection">, b: Pick<User, "connection">) => number {
  const rank = (user: Pick<User, "connection">) =>
    user.connection === scope.name ? 0 : 1;
  return (a, b) => rank(a) - rank(b);
}

/**
 * Build the scope for a lookup in database connection `name`.
 *
 * Returns `undefined` (an unscoped lookup, the behaviour before #1702) when:
 * - no name is given,
 * - the tenant has at most one database connection: there is nothing to tell
 *   apart, so single-connection tenants never change behaviour,
 * - `name` is not one of the tenant's database connections, for example the
 *   generic `Username-Password-Authentication` realm on a tenant whose
 *   connection has another name.
 *
 * Lists connections without params so the read is served from the request's
 * client bundle where one exists.
 */
export async function resolveDatabaseConnectionScope(
  connections: Pick<ConnectionsAdapter, "list">,
  tenant_id: string,
  name: string | undefined,
): Promise<DatabaseConnectionScope | undefined> {
  if (!name) return undefined;

  const { connections: all } = await connections.list(tenant_id);
  const databaseConnectionNames = new Set(
    all
      .filter((connection) => isDatabaseConnectionStrategy(connection.strategy))
      .map((connection) => connection.name),
  );

  if (databaseConnectionNames.size < 2 || !databaseConnectionNames.has(name)) {
    return undefined;
  }

  return { name, databaseConnectionNames };
}

/**
 * The database connection a login or signup for `client` targets. Lookups
 * scope to it and new database users are written with it, so the two always
 * agree.
 *
 * - An explicit realm other than the generic `Username-Password-Authentication`
 *   is used as is.
 * - The generic realm (the default) resolves to a client connection carrying
 *   that exact name, else to the client's only database connection.
 * - With several database connections on the client and none named like the
 *   generic realm, the generic name is returned. A user written with it is
 *   visible to every scope unless a tenant connection has that name, and
 *   {@link resolveDatabaseConnectionScope} leaves a lookup by it unscoped
 *   under the same condition.
 *
 * Choosing between several database connections on one client is #1703; this
 * deliberately does not guess.
 */
export function resolveClientDatabaseConnectionName(
  client: { connections: Pick<Connection, "name" | "strategy">[] },
  realm: string = Strategy.USERNAME_PASSWORD,
): string {
  if (realm !== Strategy.USERNAME_PASSWORD) return realm;

  const databaseConnections = client.connections.filter((connection) =>
    isDatabaseConnectionStrategy(connection.strategy),
  );
  if (databaseConnections.some((c) => c.name === realm)) return realm;
  const [only] = databaseConnections;
  if (only && databaseConnections.length === 1) return only.name;
  return realm;
}
