import { LoginSession } from "@authhero/adapter-interfaces";

export type LoginSessionTenant =
  | { ok: true; tenantId: string | undefined }
  | { ok: false };

/**
 * The tenant a state-keyed request (/callback, /authorize/resume, the
 * universal login screens) runs in.
 *
 * A request whose host or header resolved a tenant only ever serves that
 * tenant's login sessions. Some adapters (kysely) load the session by id
 * alone, so a session of another tenant can come back here: callers must
 * treat `ok: false` exactly like a missing session, otherwise one tenant's
 * login screens could be served on another tenant's domain.
 *
 * When the request carries no tenant, the session row is the authoritative
 * record of the flow's tenant. A CIMD client_id (https URL) has a stub row in
 * every tenant that uses it, so it can't identify the tenant (#1731).
 */
export function resolveLoginSessionTenant(
  requestTenantId: string | undefined,
  loginSession: Pick<LoginSession, "tenant_id">,
): LoginSessionTenant {
  if (
    requestTenantId &&
    loginSession.tenant_id &&
    loginSession.tenant_id !== requestTenantId
  ) {
    return { ok: false };
  }
  return { ok: true, tenantId: requestTenantId || loginSession.tenant_id };
}
