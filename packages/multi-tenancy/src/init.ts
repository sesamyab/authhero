import {
  init,
  AuthHeroConfig,
  fetchAll,
  DataAdapters,
  Tenant,
  CreateTenantParams,
} from "authhero";
import { createSyncHooks, EntitySyncConfig } from "./hooks/sync";
import { createProvisioningHooks } from "./hooks";
import {
  createInProcessDetach,
  createInProcessSyncConfig,
  createInlineExecutor,
  createOperationRecorder,
  enqueueTenantOperation,
  runDetachStep,
  runSyncDefaultsStep,
} from "./operations";
import type {
  DetachConfigFn,
  SyncConfigFn,
  TenantOperationExecutor,
} from "./operations";
import {
  createRolloutController,
  createRolloutWriteHooks,
  getConfigSyncStatus,
  type RolloutDeps,
} from "./rollouts";
import { createTenantsOpenAPIRouter } from "./routes";
import {
  buildResolver,
  createConfigSyncResolver,
  createProtectSyncedMiddleware,
  withRuntimeFallback,
  withSystemResourceServerInheritance,
} from "./middleware";
import type { ControlPlaneResolver } from "./middleware";
import type { InheritanceShadowOptions } from "./inheritance";
import { TenantEntityHooks, TenantHookContext } from "./types";

/**
 * Control plane configuration for multi-tenancy.
 */
export interface ControlPlaneConfig {
  /**
   * The control plane tenant ID - the tenant that manages all other tenants.
   */
  tenantId: string;

  /**
   * The control plane client ID used for fallback client settings.
   * This client's configuration (web_origins, callbacks, etc.) will
   * be merged with child tenant clients at runtime.
   */
  clientId: string;
}

/**
 * Configuration for multi-tenant AuthHero initialization.
 */
export interface MultiTenantConfig extends Omit<
  AuthHeroConfig,
  "entityHooks" | "managementApiExtensions"
> {
  /**
   * Control plane configuration. If provided, enables:
   * - Runtime fallback for connections, clients, and tenant settings
   * - Organization-based access control for the tenants API
   * - Automatic organization creation when tenants are created
   */
  controlPlane?: ControlPlaneConfig;

  /**
   * Optional per-tenant override for runtime inheritance lookups
   * (connections, hooks, resource servers, email providers). When provided,
   * this resolver replaces `controlPlane` as the source for inheritance:
   * every wrapped adapter read passes the tenant being read, and the
   * resolver decides which control plane (if any) it inherits from.
   * Return `undefined` to opt a specific tenant out of inheritance.
   *
   * Access control, sync direction, and tenant management routing always
   * use the static `controlPlane.tenantId` and are not affected by this
   * resolver.
   *
   * @example
   * ```typescript
   * const INHERITANCE_OFF = new Set(["isolated_tenant_id"]);
   *
   * initMultiTenant({
   *   dataAdapter,
   *   controlPlane: { tenantId: "main", clientId: "default" },
   *   resolveControlPlane: ({ tenant_id }) =>
   *     INHERITANCE_OFF.has(tenant_id)
   *       ? undefined
   *       : { tenantId: "main", clientId: "default" },
   * });
   * ```
   */
  resolveControlPlane?: ControlPlaneResolver;

  /**
   * Shadow mode for config inheritance: compares the parent chain resolver
   * with read-time inheritance in the background and logs differences as log
   * type `cfgdiff`, queryable per tenant. Never affects a response.
   * `true` uses the defaults.
   *
   * @default false
   */
  inheritanceShadow?: boolean | InheritanceShadowOptions;

  /**
   * How the `sync-defaults` tenant operation reaches a tenant's database. The
   * default syncs tenants that share the control plane's database in-process
   * and refuses tenants with their own worker and database; pass a transport
   * (for example a dispatch push to the tenant worker) to reach those.
   */
  syncDefaults?: SyncConfigFn;

  /**
   * How the `detach` tenant operation reaches a tenant's database. The default
   * works on tenants that share the control plane's database, in-process, and
   * refuses tenants with their own worker and database.
   */
  detachTenant?: DetachConfigFn;

  /**
   * How long each isolate remembers a tenant's `config_sync` mode. The
   * isolates that did not handle the `PATCH` notice a flip within this time.
   * It does not cover a cached client bundle, which can keep serving what was
   * read under the old mode for up to 15 minutes. Lower it for a faster flip at the cost of
   * one more `tenants.get` per isolate and tenant per period.
   * @default 10000
   */
  configSyncCacheTtlMs?: number;

  /**
   * Starts the per-tenant operations of a fleet rollout. Defaults to the same
   * inline executor as `sync-defaults` requests; Workflows deployments pass
   * `createCloudflareWorkflowsExecutor(...)` so waves run durably.
   */
  rolloutExecutor?: TenantOperationExecutor;

  /**
   * Control which entities to sync from control plane to child tenants.
   * Set to `false` to disable all syncing.
   * @default { resourceServers: true, roles: true }
   */
  sync?:
    | {
        resourceServers?: boolean;
        roles?: boolean;
      }
    | false;

  /**
   * Default permissions to grant when creating a tenant organization.
   * @default ["tenant:admin"]
   */
  defaultPermissions?: string[];

  /**
   * Whether to require organization match for tenant access.
   * @default false
   */
  requireOrganizationMatch?: boolean;

  /**
   * Additional management API extensions to mount.
   * The tenants router is automatically added.
   */
  managementApiExtensions?: AuthHeroConfig["managementApiExtensions"];

  /**
   * Additional entity hooks to merge with sync hooks.
   * Sync hooks will be called first, then your custom hooks.
   */
  entityHooks?: AuthHeroConfig["entityHooks"];

  /**
   * Custom function to get child tenant IDs.
   * By default, queries all tenants except the control plane.
   */
  getChildTenantIds?: () => Promise<string[]>;

  /**
   * Custom function to get adapters for a specific tenant.
   * By default, returns the main dataAdapter for all tenants.
   * Override this for per-tenant database isolation.
   */
  getAdapters?: (tenantId: string) => Promise<DataAdapters>;
}

/**
 * Result from initMultiTenant
 */
export interface MultiTenantResult {
  /** The configured Hono app */
  app: ReturnType<typeof init>["app"];
  /** The control plane tenant ID */
  controlPlaneTenantId: string;
  /**
   * What a scheduled handler needs to keep fleet rollouts moving, present when
   * the control plane carries the rollouts and tenant operations adapters:
   *
   * ```typescript
   * async scheduled(_event, env) {
   *   if (!rollouts) return;
   *   await reconcileConfigDrift(rollouts); // catches lost triggers
   *   await advanceRollouts(rollouts);      // starts the next wave
   * }
   * ```
   */
  rollouts?: RolloutDeps;
}

/**
 * Initialize a multi-tenant AuthHero application with sensible defaults.
 *
 * This is the easiest way to set up multi-tenancy. It automatically:
 * - Creates sync hooks for resource servers and roles
 * - Mounts the tenants management API at `/tenants`
 * - Adds middleware to protect synced entities on child tenants
 * - Sets up organization-based access control (when controlPlane is configured)
 * - Wraps adapters with runtime fallback from control plane
 *
 * @param config - Multi-tenant configuration
 * @returns The configured app and control plane tenant ID
 *
 * @example Basic setup
 * ```typescript
 * import { initMultiTenant } from "@authhero/multi-tenancy";
 * import createAdapters from "@authhero/kysely-adapter";
 *
 * const dataAdapter = createAdapters(db);
 *
 * const { app } = initMultiTenant({
 *   dataAdapter,
 *   controlPlane: {
 *     tenantId: "main",
 *     clientId: "default",
 *   },
 * });
 *
 * export default app;
 * ```
 *
 * @example With customization
 * ```typescript
 * const { app } = initMultiTenant({
 *   dataAdapter,
 *   controlPlane: {
 *     tenantId: "main",
 *     clientId: "default",
 *   },
 *   sync: {
 *     resourceServers: true,
 *     roles: false, // Don't sync roles
 *   },
 *   defaultPermissions: ["tenant:admin", "tenant:read"],
 * });
 * ```
 *
 * @example Disable syncing entirely
 * ```typescript
 * const { app } = initMultiTenant({
 *   dataAdapter,
 *   controlPlane: {
 *     tenantId: "main",
 *     clientId: "default",
 *   },
 *   sync: false, // Each tenant manages their own entities
 * });
 * ```
 */
export function initMultiTenant(config: MultiTenantConfig): MultiTenantResult {
  const {
    dataAdapter: rawDataAdapter,
    controlPlane,
    controlPlane: {
      tenantId: controlPlaneTenantId = "control_plane",
      clientId: controlPlaneClientId,
    } = {},
    resolveControlPlane,
    inheritanceShadow,
    syncDefaults,
    detachTenant,
    rolloutExecutor,
    sync = { resourceServers: true, roles: true },
    defaultPermissions = ["tenant:admin"],
    requireOrganizationMatch = false,
    managementApiExtensions = [],
    entityHooks: customEntityHooks,
    getChildTenantIds,
    getAdapters,
    ...restConfig
  } = config;

  if (resolveControlPlane && !controlPlane) {
    throw new Error(
      "initMultiTenant: `resolveControlPlane` requires `controlPlane` to be set. " +
        "The static `controlPlane.tenantId` is used for access control, sync direction, " +
        "and tenant management routing; the resolver only overrides per-tenant runtime " +
        "inheritance lookups on top of it.",
    );
  }

  // Wrap adapters with runtime fallback from control plane (only if controlPlane is configured)
  // - dataAdapter: Full fallback with secrets (for auth flows)
  // - managementDataAdapter: Raw adapter with multiTenancyConfig for access control (no fallback merging)
  let dataAdapter = rawDataAdapter;
  let managementDataAdapter = rawDataAdapter;
  let forgetConfigSyncMode: ((tenantId: string) => void) | undefined;

  if (controlPlane) {
    // One per-tenant `config_sync` resolver for the auth adapter, the
    // management adapter and the helpers that read `multiTenancyConfig`, so a
    // tenant in `synced` mode stops inheriting everywhere at once.
    const configSync = createConfigSyncResolver({
      base: buildResolver({
        controlPlaneTenantId,
        controlPlaneClientId,
        resolveControlPlane,
      }),
      getTenant: async (id) => (await rawDataAdapter.tenants.get(id)) ?? null,
      controlPlaneTenantId,
      ttlMs: config.configSyncCacheTtlMs,
    });

    forgetConfigSyncMode = (tenantId) => configSync.invalidate(tenantId);

    dataAdapter = withRuntimeFallback(rawDataAdapter, {
      controlPlaneTenantId,
      controlPlaneClientId,
      resolveControlPlane,
      inheritanceShadow,
      configSync,
    });

    // Management adapter gets is_system resource_server scope inheritance
    // but no connection/client/email-provider merging (no secret leakage)
    managementDataAdapter = {
      ...withSystemResourceServerInheritance(rawDataAdapter, {
        controlPlaneTenantId,
        resolveControlPlane: configSync.resolve,
      }),
      multiTenancyConfig: {
        controlPlaneTenantId,
        controlPlaneClientId,
        resolveControlPlane: configSync.resolve,
      },
    };
  }

  // Wire a default inline executor for tenant operations (issue #1026)
  // when the control plane carries the operations adapters and an upgrade
  // handler is configured. Downstream deployments can pass their own
  // `tenantOperationExecutor` (e.g. Cloudflare Workflows) to override.
  let tenantOperationExecutor = restConfig.tenantOperationExecutor;
  let inlineSyncExecutor: TenantOperationExecutor | undefined;
  if (rawDataAdapter.tenantOperations && rawDataAdapter.tenantOperationEvents) {
    const stores = {
      tenantOperations: rawDataAdapter.tenantOperations,
      tenantOperationEvents: rawDataAdapter.tenantOperationEvents,
    };
    const tenantUpgrade = restConfig.tenantUpgrade;
    const recorder = createOperationRecorder(stores);
    // Tenants that share the control plane's database are synced in-process;
    // pass `syncDefaults` to reach tenants with their own database.
    const syncConfig =
      syncDefaults ??
      createInProcessSyncConfig(rawDataAdapter, {
        controlPlaneTenantId,
        resolveControlPlane,
      });
    const detach = detachTenant ?? createInProcessDetach(rawDataAdapter);
    const inlineExecutor = createInlineExecutor({
      stores,
      definitions: {
        detach: (operation) => [
          {
            name: "detach",
            run: () =>
              runDetachStep({
                operation,
                detachTenant: detach,
                recorder,
                // Another isolate notices within the mode cache time.
                onDetached: (id) => forgetConfigSyncMode?.(id),
              }),
          },
        ],
        ...(tenantUpgrade
          ? {
              upgrade: (operation) => [
                {
                  name: "upgrade",
                  async run() {
                    if (!operation.tenant_id) {
                      throw new Error("upgrade operations require a tenant_id");
                    }
                    await tenantUpgrade(operation.tenant_id);
                  },
                },
              ],
            }
          : {}),
        "sync-defaults": (operation) => [
          {
            name: "sync-defaults",
            run: () => runSyncDefaultsStep({ operation, syncConfig, recorder }),
          },
        ],
      },
    });
    inlineSyncExecutor = inlineExecutor;
    tenantOperationExecutor ??= {
      engine: inlineExecutor.engine,
      kinds: tenantUpgrade
        ? ["upgrade", "sync-defaults", "detach"]
        : ["sync-defaults", "detach"],
      enqueue: (params) =>
        enqueueTenantOperation(
          stores,
          inlineExecutor,
          { ...params, tenant_id: params.tenant_id },
          // A sync reports its outcome in the operation row, so a failed run
          // is returned (status "failed") rather than thrown.
          {
            returnFailed:
              params.kind === "sync-defaults" || params.kind === "detach",
          },
        ),
    };
  }

  // Fleet rollouts of synced config (issue #1499): the controller behind
  // POST /rollouts, the deps a scheduled handler ticks, and the write trigger.
  const rolloutRunner = rolloutExecutor ?? inlineSyncExecutor;
  const rolloutDeps: RolloutDeps | undefined =
    rolloutRunner &&
    rawDataAdapter.rollouts &&
    rawDataAdapter.tenantOperations &&
    rawDataAdapter.tenantOperationEvents
      ? {
          adapters: rawDataAdapter,
          executor: rolloutRunner,
          controlPlaneTenantId,
          resolveControlPlane,
        }
      : undefined;
  const rolloutController = rolloutDeps
    ? createRolloutController(rolloutDeps)
    : undefined;
  const rolloutWriteHooks = rolloutDeps
    ? createRolloutWriteHooks(rolloutDeps, { logger: console })
    : undefined;

  // Determine sync settings
  const syncEnabled = sync !== false;
  const syncConfig = syncEnabled
    ? {
        resourceServers: sync.resourceServers ?? true,
        roles: sync.roles ?? true,
      }
    : { resourceServers: false, roles: false };

  // Create default getChildTenantIds if not provided
  const defaultGetChildTenantIds = async (): Promise<string[]> => {
    const allTenants = await fetchAll<Tenant>(
      (params) => dataAdapter.tenants.list(params),
      "tenants",
      { cursorField: "id", pageSize: 100 },
    );
    return allTenants
      .filter((t) => t.id !== controlPlaneTenantId)
      .map((t) => t.id);
  };

  // Create default getAdapters if not provided (single database for all tenants)
  const defaultGetAdapters = async (): Promise<DataAdapters> => dataAdapter;

  // Build sync hooks configuration
  const syncHooksConfig: EntitySyncConfig = {
    controlPlaneTenantId,
    getChildTenantIds: getChildTenantIds ?? defaultGetChildTenantIds,
    getAdapters: getAdapters ?? defaultGetAdapters,
    getControlPlaneAdapters: async () => dataAdapter,
    sync: syncConfig,
  };

  // Create sync hooks
  const { entityHooks: syncEntityHooks, tenantHooks } =
    createSyncHooks(syncHooksConfig);

  // Combine sync hooks with custom hooks using arrays
  // authhero will chain them with proper return value handling
  // Note: customEntityHooks already uses array format from AuthHeroConfig
  // Note: Connections are NOT synced - they use runtime fallback by strategy instead
  const entityHooks: AuthHeroConfig["entityHooks"] = {
    resourceServers: [
      syncEntityHooks.resourceServers,
      rolloutWriteHooks?.resourceServers,
      ...(customEntityHooks?.resourceServers ?? []),
    ],
    roles: [syncEntityHooks.roles, ...(customEntityHooks?.roles ?? [])],
    connections: [
      rolloutWriteHooks?.connections,
      ...(customEntityHooks?.connections ?? []),
    ],
    tenants: customEntityHooks?.tenants ?? [],
    rolePermissions: customEntityHooks?.rolePermissions ?? [],
    actions: [
      rolloutWriteHooks?.actions,
      ...(customEntityHooks?.actions ?? []),
    ],
    hooks: [rolloutWriteHooks?.hooks, ...(customEntityHooks?.hooks ?? [])],
    hookCode: [
      rolloutWriteHooks?.hookCode,
      ...(customEntityHooks?.hookCode ?? []),
    ],
  };

  // Create provisioning hooks for organization creation on tenant creation
  const provisioningHooks = createProvisioningHooks({
    accessControl: {
      controlPlaneTenantId,
      requireOrganizationMatch,
      defaultPermissions,
    },
  });

  // Chain provisioning hooks (org creation) with sync hooks (entity syncing)
  const combinedTenantHooks: TenantEntityHooks = {
    async beforeCreate(
      ctx: TenantHookContext,
      params: CreateTenantParams,
    ): Promise<CreateTenantParams> {
      if (provisioningHooks.beforeCreate) {
        params = await provisioningHooks.beforeCreate(ctx, params);
      }
      if (tenantHooks.beforeCreate) {
        params = await tenantHooks.beforeCreate(ctx, params);
      }
      return params;
    },
    async afterCreate(ctx: TenantHookContext, tenant: Tenant): Promise<void> {
      await provisioningHooks.afterCreate?.(ctx, tenant);
      await tenantHooks.afterCreate?.(ctx, tenant);
    },
    async beforeDelete(
      ctx: TenantHookContext,
      tenantId: string,
    ): Promise<void> {
      await provisioningHooks.beforeDelete?.(ctx, tenantId);
      await tenantHooks.beforeDelete?.(ctx, tenantId);
    },
  };

  // Create tenants router
  const tenantsRouter = createTenantsOpenAPIRouter(
    {
      accessControl: {
        controlPlaneTenantId,
        requireOrganizationMatch,
        defaultPermissions,
      },
      onConfigSyncChange: (tenantId) => forgetConfigSyncMode?.(tenantId),
      configSyncStatus: (tenantId) =>
        getConfigSyncStatus(
          {
            adapters: rawDataAdapter,
            controlPlaneTenantId,
            resolveControlPlane,
          },
          tenantId,
        ),
    },
    { tenants: combinedTenantHooks },
  );

  // Initialize AuthHero
  const { app } = init({
    dataAdapter,
    managementDataAdapter,
    ...restConfig,
    tenantOperationExecutor,
    ...(rolloutController ? { rolloutController } : {}),
    entityHooks,
    managementApiExtensions: [
      ...managementApiExtensions,
      { path: "/tenants", router: tenantsRouter },
    ],
    // Child tenants must not modify entities synced from the control plane.
    // This has to run inside the management API (after auth, before the
    // routes): middleware added to `app` after init() never runs for the
    // already-mounted management routes.
    managementApiMiddleware: [
      ...(restConfig.managementApiMiddleware ?? []),
      ...(syncEnabled ? [createProtectSyncedMiddleware()] : []),
    ],
  });

  return { app, controlPlaneTenantId, rollouts: rolloutDeps };
}
