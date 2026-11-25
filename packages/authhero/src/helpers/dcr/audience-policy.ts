import type { Context } from "hono";
import type { Bindings, Variables } from "../../types";
import { MANAGEMENT_API_AUDIENCE } from "../../middlewares/authentication";

/**
 * Dynamic Client Registration never provisions a client grant for the
 * Management API: the built-in `urn:authhero:management` identifier and any
 * extra management audiences the deployment accepts
 * (`init({ additionalManagementAudiences })`). Clients that need Management
 * API access are created through the Management API itself.
 */
export async function isRegistrationDeniedAudience(
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>,
  tenantId: string,
  audience: string,
): Promise<boolean> {
  if (audience === MANAGEMENT_API_AUDIENCE) {
    return true;
  }
  const resolver = ctx.env.additionalManagementAudiences;
  if (!resolver) {
    return false;
  }
  const extra = await resolver({ tenant_id: tenantId });
  return extra.includes(audience);
}
