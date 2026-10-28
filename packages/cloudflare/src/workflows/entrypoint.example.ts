/**
 * REFERENCE ONLY — not part of the published bundle (nothing imports it).
 *
 * The downstream control-plane worker (the deploy repo) owns the
 * `WorkflowEntrypoint` shell, because `cloudflare:workers` only exists in
 * the Workers runtime. Everything else — orchestration, verify, write-back
 * — comes from `@authhero/cloudflare-adapter/workflows`.
 *
 * wrangler.jsonc:
 * ```jsonc
 * {
 *   "workflows": [
 *     {
 *       "name": "tenant-operations",
 *       "binding": "TENANT_OPERATIONS_WORKFLOW",
 *       "class_name": "TenantOperationWorkflow"
 *     }
 *   ],
 *   // Reconciler cadence: at least daily (engine retention is 30 days);
 *   // every 15–60 minutes recommended.
 *   "triggers": { "crons": ["0,30 * * * *"] }
 * }
 * ```
 *
 * Worker module:
 * ```ts
 * import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
 * import {
 *   createProvisionVerifier,
 *   createCloudflareWorkflowsExecutor,
 *   createWfpWorkflowProvisioningHook,
 *   reconcileTenantOperations,
 *   runProvisionOperation,
 *   runSyncDefaultsOperation,
 *   runDetachOperation,
 *   type ProvisionOperationDeps,
 *   type TenantOperationWorkflowParams,
 * } from "@authhero/cloudflare-adapter/workflows";
 * import { enqueueTenantOperation } from "@authhero/multi-tenancy";
 * import {
 *   createWfpProvisionerSteps,
 *   createWfpTenantProvisioningHook,
 *   CloudflareApiClient,
 * } from "@authhero/cloudflare-adapter";
 * import {
 *   createDispatchSyncConfig,
 *   createDispatchDetach,
 *   createDispatchSyncDefaults,
 * } from "@authhero/cloudflare-adapter/wfp";
 *
 * // Host-owned: build every workflow dependency from the worker env. Params
 * // carry only { operation_id, tenant_id, kind } — never secrets.
 * function buildProvisionDeps(env: Env): ProvisionOperationDeps {
 *   const adapters = createControlPlaneAdapters(env); // host's DB wiring
 *   const steps = createWfpProvisionerSteps({
 *     accountId: env.CLOUDFLARE_ACCOUNT_ID,
 *     apiToken: env.CLOUDFLARE_API_TOKEN,
 *     dispatchNamespace: "authhero-tenants",
 *     controlPlaneBaseUrl: env.PUBLIC_BASE_URL,
 *     tenantWorkerScript,
 *     migrations,
 *     secrets: async (tenantId) => ({ ... }),
 *   });
 *   return {
 *     steps,
 *     tenants: adapters.tenants,
 *     stores: {
 *       tenantOperations: adapters.tenantOperations!,
 *       tenantOperationEvents: adapters.tenantOperationEvents!,
 *     },
 *     syncDefaults: createDispatchSyncDefaults({ ... }),
 *     verify: createProvisionVerifier({ client: steps.client }),
 *   };
 * }
 *
 * export class TenantOperationWorkflow extends WorkflowEntrypoint<Env, TenantOperationWorkflowParams> {
 *   async run(event: WorkflowEvent<TenantOperationWorkflowParams>, step: WorkflowStep) {
 *     // CF's WorkflowStep satisfies StepRunner structurally. One class runs
 *     // every kind; params carry the kind, never secrets.
 *     switch (event.payload.kind) {
 *       case "detach": {
 *         const adapters = createControlPlaneAdapters(this.env);
 *         return runDetachOperation(
 *           {
 *             stores: {
 *               tenantOperations: adapters.tenantOperations!,
 *               tenantOperationEvents: adapters.tenantOperationEvents!,
 *             },
 *             // Checks the tenant row on the control plane, asks the tenant
 *             // worker's /internal/detach to convert its rows, then marks the
 *             // control-plane row detached.
 *             detachTenant: createDispatchDetach({
 *               dispatcher: this.env.DISPATCHER,
 *               internalSecret: this.env.WFP_INTERNAL_SYNC_SECRET,
 *               controlPlaneAdapters: adapters,
 *             }),
 *           },
 *           event.payload,
 *           step,
 *         );
 *       }
 *       case "sync-defaults": {
 *         const adapters = createControlPlaneAdapters(this.env);
 *         return runSyncDefaultsOperation(
 *           {
 *             stores: {
 *               tenantOperations: adapters.tenantOperations!,
 *               tenantOperationEvents: adapters.tenantOperationEvents!,
 *             },
 *             // Reads the chain as stored (ciphertext) and pushes the
 *             // resolved block to the tenant worker's /internal/sync-config.
 *             syncConfig: createDispatchSyncConfig({
 *               dispatcher: this.env.DISPATCHER,
 *               internalSecret: this.env.WFP_INTERNAL_SYNC_SECRET,
 *               controlPlaneTenantId: this.env.CONTROL_PLANE_TENANT_ID,
 *               controlPlaneAdapters: adapters,
 *             }),
 *           },
 *           event.payload,
 *           step,
 *         );
 *       }
 *       default:
 *         return runProvisionOperation(buildProvisionDeps(this.env), event.payload, step);
 *     }
 *   }
 * }
 *
 * export default {
 *   fetch: app.fetch,
 *   async scheduled(_controller: ScheduledController, env: Env) {
 *     const adapters = createControlPlaneAdapters(env);
 *     const result = await reconcileTenantOperations({
 *       stores: {
 *         tenantOperations: adapters.tenantOperations!,
 *         tenantOperationEvents: adapters.tenantOperationEvents!,
 *       },
 *       tenants: adapters.tenants,
 *       binding: env.TENANT_OPERATIONS_WORKFLOW,
 *     });
 *     console.log("reconcileTenantOperations", result);
 *
 *     // Fleet rollouts of synced config (initMultiTenant's `rollouts`):
 *     // find tenants whose applied config no longer matches what their
 *     // parents publish (the safety net for lost write triggers), then start
 *     // the next wave of every open rollout. Pass a Workflows executor as
 *     // initMultiTenant's `rolloutExecutor` to run the waves durably.
 *     //   await reconcileConfigDrift(rollouts);
 *     //   await advanceRollouts(rollouts);
 *   },
 * };
 *
 * // Tenant create wiring — replaces the inline provision (and any
 * // best-effort post-create seed) with a durable enqueue:
 * const inlineHook = createWfpTenantProvisioningHook({ provisioner, tenants, syncDefaults });
 * const workflowHook = createWfpWorkflowProvisioningHook({
 *   tenants: adapters.tenants,
 *   inline: inlineHook, // upgrade/deprovision stay inline until phase 3/4
 *   enqueueOperation: (input) =>
 *     enqueueTenantOperation(
 *       stores,
 *       createCloudflareWorkflowsExecutor({ binding: env.TENANT_OPERATIONS_WORKFLOW }),
 *       input,
 *     ),
 * });
 * // databaseIsolation: {
 * //   getAdapters,
 * //   onProvision: workflowHook.onProvision,
 * //   onDeprovision: workflowHook.onDeprovision,
 * //   recordProvisionOperations: false, // the workflow owns the operation row
 * // }
 * ```
 *
 * Rollout order for existing deployments: apply the control-plane
 * migrations first, deploy the worker with both paths available, then flip
 * tenant-create to the workflow hook.
 */
export {};
