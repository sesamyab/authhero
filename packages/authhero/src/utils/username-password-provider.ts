import { User } from "@authhero/adapter-interfaces";
import { Context } from "hono";
import { Bindings, Variables } from "../types";
import { EnrichedClient } from "../helpers/client";
import {
  getOrCreateUserByProvider,
  getUserByProvider,
  resolvePrimaryUser,
} from "../helpers/users";
import { resolveDatabaseConnectionScope } from "../helpers/database-connection-scope";

/**
 * TRANSITIONAL helpers for the auth2 → auth0 provider migration.
 *
 * Historically every native database user has been stored with
 * `provider = "auth2"` and `user_id = "auth2|<id>"`. New rows are now
 * written with the `"auth0"` provider value everywhere; the
 * `init({ usernamePasswordProvider })` resolver only exists to pin a
 * tenant back onto `"auth2"` during a staged cutover.
 *
 * Two surfaces are exposed:
 *
 * - {@link resolveUsernamePasswordProvider} — used at WRITE sites to pick
 *   the value to stamp on a new row. Defaults to `"auth0"`.
 * - {@link isUsernamePasswordProvider} / {@link getUsernamePasswordUser} /
 *   {@link getPrimaryUsernamePasswordUser} — used at READ sites to match
 *   existing rows under EITHER value, so a tenant can have a mix of
 *   `auth2|*` and `auth0|*` rows during/after the cutover.
 *
 * Once every tenant has been backfilled to a single provider value, this
 * module and its callers can be deleted in favour of a plain constant.
 */

const LEGACY_PROVIDER = "auth2";
const TARGET_PROVIDER = "auth0";

// Shared with the admin UI via adapter-interfaces. None of the matched
// strategy spellings may ever leak into new user rows as the provider —
// write sites go through {@link resolveUsernamePasswordProvider} instead.
export { isDatabaseConnectionStrategy } from "@authhero/adapter-interfaces";

export type UsernamePasswordProviderValue =
  | typeof LEGACY_PROVIDER
  | typeof TARGET_PROVIDER;

/**
 * Both native database provider values, legacy first — for read sites
 * that need to enumerate rather than predicate-match.
 */
export const USERNAME_PASSWORD_PROVIDERS: readonly UsernamePasswordProviderValue[] =
  [LEGACY_PROVIDER, TARGET_PROVIDER];

export async function resolveUsernamePasswordProvider(
  env: Bindings,
  tenant_id: string,
): Promise<UsernamePasswordProviderValue> {
  if (!env.usernamePasswordProvider) {
    return TARGET_PROVIDER;
  }
  return env.usernamePasswordProvider({ tenant_id });
}

export function isUsernamePasswordProvider(
  provider: string | undefined | null,
): boolean {
  return provider === LEGACY_PROVIDER || provider === TARGET_PROVIDER;
}

interface DualReadParams {
  env: Bindings;
  tenant_id: string;
  username: string;
  /**
   * Name of the database connection to look in (#1702). Rows of the tenant's
   * other database connections are skipped. Has no effect for tenants with a
   * single database connection, or when the name isn't one of the tenant's
   * database connections; see `resolveDatabaseConnectionScope`.
   */
  connection?: string;
}

/**
 * Look up a native database user, accepting either provider value.
 *
 * ALWAYS tries `"auth2"` first, then `"auth0"`, regardless of the tenant's
 * configured write value. The `auth2` row is the one carrying the bcrypt
 * password legacy users have been logging in with — if both rows happen
 * to coexist for the same identifier (partial backfill, Auth0 import,
 * etc.) we want login to keep using the `auth2` row so credentials
 * continue to work. The migration script merges the duplicates.
 */
export async function getUsernamePasswordUser({
  env,
  tenant_id,
  username,
  connection,
}: DualReadParams): Promise<User | null> {
  const scope = await resolveDatabaseConnectionScope(
    env.data.connections,
    tenant_id,
    connection,
  );
  const lookup = (provider: UsernamePasswordProviderValue) =>
    getUserByProvider({
      userAdapter: env.data.users,
      tenant_id,
      username,
      provider,
      connection: scope,
    });

  const legacy = await lookup(LEGACY_PROVIDER);
  // Unscoped, or an exact match in the scoped connection: auth2 wins.
  if (legacy && (!scope || legacy.connection === scope.name)) return legacy;

  const target = await lookup(TARGET_PROVIDER);
  if (!scope) return target;

  // Scoped: a row in the connection itself beats an unattributed legacy row
  // (one whose `connection` names no database connection), whichever
  // provider it has. Otherwise a login scoped to one connection could check
  // the password of, and issue tokens for, a legacy user of another one.
  if (target && target.connection === scope.name) return target;
  return legacy ?? target;
}

/**
 * Same as {@link getUsernamePasswordUser} but resolves to the primary user
 * if a linked secondary is matched. Same ordering: the row is chosen first,
 * then its cluster root.
 */
export async function getPrimaryUsernamePasswordUser(
  params: DualReadParams,
): Promise<User | null> {
  const user = await getUsernamePasswordUser(params);
  if (!user) return null;
  return resolvePrimaryUser(params.env.data.users, params.tenant_id, user);
}

/**
 * Find-or-create wrapper that first looks for an existing native database
 * user under EITHER provider value, and only creates a new row (under the
 * configured provider) if none exists. Prevents duplicating an existing
 * `auth2|*` user when the tenant is migrated to `"auth0"`.
 *
 * `connection` is written on a new row and scopes the existing-user lookup,
 * see {@link DualReadParams}.
 */
export async function getOrCreateUsernamePasswordUser(
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>,
  params: {
    client: EnrichedClient;
    username: string;
    connection: string;
    ip?: string;
  },
): Promise<User> {
  const { client, username, connection, ip } = params;
  const existing = await getUsernamePasswordUser({
    env: ctx.env,
    tenant_id: client.tenant.id,
    username,
    connection,
  });
  if (existing) {
    return existing;
  }
  const provider = await resolveUsernamePasswordProvider(
    ctx.env,
    client.tenant.id,
  );
  return getOrCreateUserByProvider(ctx, {
    client,
    username,
    provider,
    connection,
    isSocial: false,
    ip,
  });
}
