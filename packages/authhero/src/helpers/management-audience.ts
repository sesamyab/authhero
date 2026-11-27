import type { Context } from "hono";
import type { Bindings, Variables } from "../types";
import { MANAGEMENT_API_AUDIENCE } from "../middlewares/authentication";

/**
 * True when `audience` is one the Management API accepts for this tenant: the
 * built-in `urn:authhero:management` identifier, or one of the extra audiences
 * the deployment configured with `init({ additionalManagementAudiences })`.
 */
export async function isManagementApiAudience(
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>,
  tenantId: string | undefined,
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
