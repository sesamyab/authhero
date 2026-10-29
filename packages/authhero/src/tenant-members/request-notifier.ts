import type { ControlPlaneClient } from "../helpers/control-plane-client";
import { CONTROL_PLANE_TENANT_MEMBERS_SCOPE } from "../routes/proxy-control-plane/scopes";
import type { AfterTenantMemberRequestRegistered } from "./requests";
import { CONTROL_PLANE_TENANT_MEMBER_REQUESTS_NOTIFY_PATH } from "./wire";

/**
 * Tells the control plane, over the shared control-plane client, that a
 * request is waiting, and records that it was told. If the control plane is
 * down the request simply stays unnotified and a control-plane sweep finds it
 * later, so this never throws.
 */
export function createControlPlaneRequestNotifier(
  client: ControlPlaneClient,
): AfterTenantMemberRequestRegistered {
  return async (ctx, request) => {
    try {
      const res = await client.request({
        tenantId: request.tenant_id,
        scope: CONTROL_PLANE_TENANT_MEMBERS_SCOPE,
        method: "POST",
        path: CONTROL_PLANE_TENANT_MEMBER_REQUESTS_NOTIFY_PATH,
        body: { request_id: request.id },
      });
      if (res.status >= 200 && res.status < 300) {
        await ctx.var.data.tenantMemberRequests?.update(
          request.tenant_id,
          request.id,
          { notified_at: new Date().toISOString() },
        );
      } else {
        console.warn(
          `[tenant-members] control plane answered ${res.status} to the notification of request ${request.id}`,
        );
      }
    } catch (err) {
      console.warn(
        `[tenant-members] could not notify the control plane of request ${request.id}:`,
        err,
      );
    }
  };
}
