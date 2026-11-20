import {
  Connection,
  ConnectionsAdapter,
  Strategy,
  User,
  isDatabaseConnectionStrategy,
} from "@authhero/adapter-interfaces";
import { JSONHTTPException } from "../errors/json-http-exception";

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
  user: Pick<User, "connection">,
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
 * The name set must cover every database connection in the tenant, or a row
 * of a missing connection would pass the scope; see
 * {@link listAllTenantConnections}.
 */
export async function resolveDatabaseConnectionScope(
  connections: Pick<ConnectionsAdapter, "list">,
  tenant_id: string,
  name: string | undefined,
): Promise<DatabaseConnectionScope | undefined> {
  if (!name) return undefined;

  const all = await listAllTenantConnections(connections, tenant_id);
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

// Page size assumed for an adapter that doesn't report the `limit` it used.
// The in-repo adapters default to 50.
const ASSUMED_DEFAULT_PAGE_SIZE = 50;
const PAGE_SIZE = 100;

/**
 * Every connection of the tenant. The first read has no params, so it is
 * served from the request's client bundle where one exists; further pages are
 * read only when that first page came back full.
 */
async function listAllTenantConnections(
  connections: Pick<ConnectionsAdapter, "list">,
  tenant_id: string,
): Promise<Connection[]> {
  const first = await connections.list(tenant_id);
  const pageSize =
    typeof first.limit === "number" && first.limit > 0
      ? first.limit
      : ASSUMED_DEFAULT_PAGE_SIZE;
  if (first.connections.length < pageSize) return first.connections;

  const all: Connection[] = [];
  for (let page = 0; ; page++) {
    const { connections: batch } = await connections.list(tenant_id, {
      page,
      per_page: PAGE_SIZE,
      include_totals: false,
    });
    all.push(...batch);
    if (batch.length < PAGE_SIZE) return all;
  }
}

/**
 * The database connection a login, signup or password reset for `client`
 * uses (#1703). This is the one place that decides it; lookups scope to it and
 * new database users are written with it, so the two always agree.
 *
 * Auth0's rule, in order:
 * 1. A connection the request names (`/authorize` `connection`, carried on the
 *    login session as `authParams.connection`; the password-realm `realm`; the
 *    `/dbconnections` `connection` field) is used when it is a database
 *    connection enabled on the client. A name that isn't enabled on the client
 *    is rejected, never replaced by another connection.
 * 2. Otherwise the client's first enabled database connection, in the
 *    client's stored order. A client with no explicit connection list (it
 *    falls back to every tenant connection, as CIMD clients do) gets its
 *    database connections oldest first, see
 *    {@link orderFallbackDatabaseConnections}, so this is the tenant's oldest.
 *
 * `Username-Password-Authentication` is the generic realm that callers from
 * before named database connections send for "this client's database
 * connection". It names a connection when one has that exact name, and
 * otherwise means "no explicit choice".
 *
 * Returns `undefined` when the client has no database connection.
 */
export function resolveClientDatabaseConnection<
  T extends Pick<Connection, "name" | "strategy">,
>(client: { connections: T[] }, requested?: string): T | undefined {
  const databaseConnections = client.connections.filter((connection) =>
    isDatabaseConnectionStrategy(connection.strategy),
  );
  if (requested) {
    const named = databaseConnections.find((c) => c.name === requested);
    if (named) return named;
    if (requested !== Strategy.USERNAME_PASSWORD) {
      throw databaseConnectionNotEnabled(requested);
    }
  }
  return databaseConnections[0];
}

/**
 * Name of the connection {@link resolveClientDatabaseConnection} picks, or the
 * generic `Username-Password-Authentication` when the client has no database
 * connection (the name such users were always written with).
 */
export function resolveClientDatabaseConnectionName(
  client: { connections: Pick<Connection, "name" | "strategy">[] },
  requested?: string,
): string {
  return (
    resolveClientDatabaseConnection(client, requested)?.name ??
    Strategy.USERNAME_PASSWORD
  );
}

/** A request named a connection that isn't a database connection of the client. */
export function databaseConnectionNotEnabled(name: string): JSONHTTPException {
  return new JSONHTTPException(400, {
    error: "invalid_request",
    error_description: `The connection ${name} is not enabled for this client.`,
  });
}

/**
 * Order a client's fallback connection list (every tenant connection, used
 * when the client enables none explicitly) so its database connections come
 * oldest first. Only the database connections move, within the slots they
 * already hold, so the order of login buttons doesn't change.
 *
 * Oldest is by `created_at`; a connection without one (imported or seeded
 * rows) counts as newest, and ties break on id.
 */
export function orderFallbackDatabaseConnections<T extends Connection>(
  connections: T[],
): T[] {
  const databaseConnections = connections
    .filter((connection) => isDatabaseConnectionStrategy(connection.strategy))
    .sort(compareByAge);
  if (databaseConnections.length < 2) return connections;
  let next = 0;
  return connections.map((connection) =>
    isDatabaseConnectionStrategy(connection.strategy)
      ? (databaseConnections[next++] ?? connection)
      : connection,
  );
}

function compareByAge(a: Connection, b: Connection): number {
  if (!!a.created_at !== !!b.created_at) return a.created_at ? -1 : 1;
  const byCreated = compareInstants(a.created_at, b.created_at);
  if (byCreated !== 0) return byCreated;
  return (a.id || a.name).localeCompare(b.id || b.name);
}

// Imported rows may carry an offset (`+01:00`), so text order isn't time
// order. Compare parsed instants; fall back to text when one doesn't parse.
function compareInstants(a = "", b = ""): number {
  const aTime = Date.parse(a);
  const bTime = Date.parse(b);
  if (Number.isNaN(aTime) || Number.isNaN(bTime)) return a.localeCompare(b);
  return aTime - bTime;
}
