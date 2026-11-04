import { Context } from "hono";
import { swaggerUI } from "@hono/swagger-ui";
import { AuthHeroConfig, DataAdapters } from "authhero";
import { initMultiTenant, type SyncConfigFn } from "@authhero/multi-tenancy";

// Control plane configuration. Tenants inherit this tenant's defaults.
const CONTROL_PLANE_TENANT_ID = "control_plane";
const CONTROL_PLANE_CLIENT_ID = "default";

export default function createApp(
  config: AuthHeroConfig & { dataAdapter: DataAdapters },
  options: {
    /**
     * How the `sync-defaults` tenant operation reaches a tenant with its own
     * Worker and database. See `buildSyncDefaults` in src/index.ts.
     */
    syncDefaults?: SyncConfigFn;
  } = {},
) {
  // initMultiTenant syncs resource servers and roles, mounts /api/v2/tenants
  // (and, because the adapters carry the operations tables,
  // /api/v2/tenants/{id}/operations and the config-sync routes), and wraps
  // adapters with runtime fallback for colocated tenants.
  const { app } = initMultiTenant({
    ...config,
    syncDefaults: options.syncDefaults,
    controlPlane: {
      tenantId: CONTROL_PLANE_TENANT_ID,
      clientId: CONTROL_PLANE_CLIENT_ID,
    },
  });

  app
    .onError((err, ctx) => {
      // Duck-typing avoids instanceof issues with bundled dependencies.
      if (
        err &&
        typeof err === "object" &&
        "getResponse" in err &&
        typeof (err as { getResponse?: unknown }).getResponse === "function"
      ) {
        return (err as { getResponse: () => Response }).getResponse();
      }
      console.error(err);
      return ctx.text(
        err instanceof Error ? err.message : "Internal Server Error",
        500,
      );
    })
    .get("/", async (ctx: Context) => {
      return ctx.json({
        name: "AuthHero Control Plane",
        status: "running",
        docs: "/docs",
        controlPlaneTenant: CONTROL_PLANE_TENANT_ID,
      });
    })
    .get("/docs", swaggerUI({ url: "/api/v2/spec" }));

  return app;
}
