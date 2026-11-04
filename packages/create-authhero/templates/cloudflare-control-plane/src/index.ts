import { drizzle } from "drizzle-orm/d1";
import createAdapters, { createProxyDataAdapter } from "@authhero/drizzle";
import * as schema from "@authhero/drizzle/schema/sqlite";
import createCloudflareAdapters, {
  syncCustomDomains,
  type CloudflareConfig,
} from "@authhero/cloudflare-adapter";
import {
  AuthHeroConfig,
  CustomDomainsAdapter,
  DataAdapters,
  createEncryptedDataAdapterWithKeyRing,
  loadEncryptionKey,
  runRetention,
  type KeyRing,
} from "authhero";
import {
  createInProcessSyncConfig,
  type SyncConfigFn,
} from "@authhero/multi-tenancy";
import { createDispatchSyncConfig } from "@authhero/cloudflare-adapter/wfp";
import createApp from "./app";
import { Env } from "./types";

const CONTROL_PLANE_TENANT_ID = "control_plane";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Hosts under the ISSUER apex are tenant subdomains (`{tenant}.{apex}`) and
    // are never looked up as custom domains. Left unset, the request's own host
    // is the apex, which only resolves a tenant while this database holds a
    // single tenant. Set ISSUER to an apex that is not this Worker's host
    // (e.g. https://token.example.com/) and add a custom_domains row for this
    // host, so the control plane tenant is found however many tenants exist.
    const issuer = env.ISSUER || `${url.protocol}//${url.host}/`;
    const origin = request.headers.get("Origin") || "";

    const {
      db,
      rawAdapter,
      dataAdapter: baseAdapter,
    } = await buildDataAdapter(env);
    let dataAdapter = baseAdapter;

    // How the `sync-defaults` tenant operation reaches a tenant. Tenants with
    // their own Worker and D1 are pushed to through the dispatch namespace;
    // tenants that share this database are synced in-process.
    const syncDefaults = buildSyncDefaults(env, rawAdapter, dataAdapter);

    // The control plane is authoritative for custom domains: it is the only
    // place that holds Cloudflare account credentials (so it can register the
    // custom hostname) and the only place that can see every tenant's domains
    // (so a hostname is claimed exactly once). Tenant shards reach this
    // through `createControlPlaneCustomDomainsAdapter`.
    const cloudflareConfig = buildCloudflareConfig(env, dataAdapter);
    const customDomains: CustomDomainsAdapter | undefined = cloudflareConfig
      ? createCloudflareAdapters(cloudflareConfig).customDomains
      : undefined;

    if (customDomains) {
      // The same adapter serves both writers, so neither can create a domain
      // that Cloudflare never hears about: colocated tenants writing through
      // this instance's management API, and WFP tenants writing through the
      // /custom-domains resource below.
      dataAdapter = { ...dataAdapter, customDomains };
    }

    const config: AuthHeroConfig & { dataAdapter: DataAdapters } = {
      dataAdapter,
      // A control plane token carries the host it was minted on as `iss`
      // (https://<custom-domain>/). A call with a `tenant-id` header acts on
      // another tenant and skips the custom-domain lookup, so the issuer check
      // would compare it to env.ISSUER instead and answer 401 "Invalid issuer"
      // whenever ISSUER is set apart from this host. Accept this host's issuer
      // for control plane tokens only; the signature is still verified.
      additionalIssuers: ({ tenant_id }) =>
        tenant_id === CONTROL_PLANE_TENANT_ID
          ? [`${url.protocol}//${url.host}/`]
          : [],
      allowedOrigins: [origin].filter(Boolean),
      proxyControlPlane: {
        resolveHost: createProxyDataAdapter(db).resolveHost,
        customDomains,
      },
    };

    const app = createApp(config, { syncDefaults });

    return app.fetch(request, { ...env, ISSUER: issuer });
  },

  // ────────────────────────────────────────────────────────────────────────
  // Retention sweep (this Worker's own D1)
  // ────────────────────────────────────────────────────────────────────────
  // Two jobs share this handler, dispatched on which cron fired:
  //
  //   */5 * * * *  custom domain sync — reconciles every hostname in the
  //                Cloudflare zone against the stored rows. Without it a
  //                domain that finishes validation at the edge stays `pending`
  //                here until somebody opens its detail page, because `list`
  //                and the routing path deliberately never call Cloudflare.
  //   0 3 * * *    retention — prunes expired `codes`, processed
  //                `outbox_events` and expired sessions in the control plane's
  //                own database, which otherwise grows without bound.
  //
  // NOTE: this sweeps only AUTH_DB (the control_plane tenant). Each WFP tenant
  // has its OWN D1 and its tenant Worker cannot carry a cron (dispatch-namespace
  // Workers don't receive scheduled events), so tenant shards must be swept
  // centrally — call `runRetention({ dataAdapter, tenantId })` against each
  // tenant's own database. That cross-tenant driver is not wired here yet; see
  // https://authhero.net/deployment/data-retention.
  async scheduled(event: ScheduledEvent, env: Env): Promise<void> {
    const { dataAdapter } = await buildDataAdapter(env);

    // An unrecognised cron runs everything, so a hand-triggered
    // `wrangler dev --test-scheduled` (which reports the first cron) still
    // exercises both jobs.
    const recognised =
      event.cron === CUSTOM_DOMAIN_SYNC_CRON || event.cron === RETENTION_CRON;

    if (event.cron === CUSTOM_DOMAIN_SYNC_CRON || !recognised) {
      const cloudflareConfig = buildCloudflareConfig(env, dataAdapter);
      if (cloudflareConfig) {
        console.log(
          "custom domain sync",
          await syncCustomDomains(cloudflareConfig),
        );
      }
    }

    if (event.cron === RETENTION_CRON || !recognised) {
      const { sweeps } = await runRetention({ dataAdapter });
      console.log("retention sweep", sweeps);
    }
  },
};

/**
 * The cron expressions from wrangler.toml. Keep the two files in step: an
 * unrecognised cron falls through to running every job, which is safe but
 * makes the daily retention pass run on the five-minute schedule.
 */
const CUSTOM_DOMAIN_SYNC_CRON = "*/5 * * * *";
const RETENTION_CRON = "0 3 * * *";

/**
 * Cloudflare zone credentials, or `undefined` when custom domains are not
 * configured. Shared by the request path and the sync cron so both address the
 * same zone through the same database adapter.
 */
function buildCloudflareConfig(
  env: Env,
  dataAdapter: DataAdapters,
): CloudflareConfig | undefined {
  if (
    !env.CLOUDFLARE_ZONE_ID ||
    !env.CLOUDFLARE_API_KEY ||
    !env.CLOUDFLARE_API_EMAIL
  ) {
    return undefined;
  }

  return {
    zoneId: env.CLOUDFLARE_ZONE_ID,
    authKey: env.CLOUDFLARE_API_KEY,
    authEmail: env.CLOUDFLARE_API_EMAIL,
    // On an Enterprise zone the hostname carries its owning tenant, so every
    // ownership check — adoption on create, reads, and the sync sweep's refusal
    // to mirror across a tenant boundary — can actually verify it.
    enterprise: env.CLOUDFLARE_ZONE_ENTERPRISE === "true",
    // The Cloudflare adapter performs the zone-level side effect and persists
    // the row through this database adapter.
    customDomainAdapter: dataAdapter.customDomains,
  };
}

/**
 * Build the DataAdapters over the control plane's own D1 (AUTH_DB). Shared by
 * the request path and the retention cron so both see the same schema,
 * transaction and encryption configuration. The fetch handler decorates the
 * returned adapter with custom-domains support after this base is built.
 *
 * `controlPlane: true` adds the tenant-operation and rollout adapters, which
 * is also what mounts the operations routes (`POST /tenants/{id}/operations`).
 * It needs the `drizzle-control-plane/` migration set (`npm run
 * db:migrate:control-plane:remote`) on top of the core one.
 *
 * Encryption uses a key ring: the control plane's own rows under
 * ENCRYPTION_KEY, and the `control_plane` tenant's rows (the shared secrets
 * that get synced to tenants) under the "cp" key id. A sync copies ciphertext
 * as stored, so a tenant can only decrypt what it receives if it holds the same
 * CONTROL_PLANE_ENCRYPTION_KEY. Legacy single-key values stay readable.
 *
 * Returns both layers: `rawAdapter` stores secrets as ciphertext (what a sync
 * copies) and `dataAdapter` decrypts them.
 */
async function buildDataAdapter(env: Env) {
  const db = drizzle(env.AUTH_DB, { schema });
  const rawAdapter: DataAdapters = createAdapters(db, {
    useTransactions: false,
    controlPlane: true,
  });
  let dataAdapter: DataAdapters = rawAdapter;
  if (env.ENCRYPTION_KEY) {
    const defaultKey = await loadEncryptionKey(env.ENCRYPTION_KEY);
    const ring: KeyRing = env.CONTROL_PLANE_ENCRYPTION_KEY
      ? {
          default: defaultKey,
          keys: {
            cp: await loadEncryptionKey(env.CONTROL_PLANE_ENCRYPTION_KEY),
          },
        }
      : { default: defaultKey };
    dataAdapter = createEncryptedDataAdapterWithKeyRing(rawAdapter, ring, {
      resolveEncryptKeyId: (tenantId) =>
        tenantId === CONTROL_PLANE_TENANT_ID ? "cp" : undefined,
    });
  }
  return { db, rawAdapter, dataAdapter };
}

/**
 * The transport behind the `sync-defaults` operation. A tenant with its own
 * Worker and D1 (`deployment_type: "wfp"`) is pushed to through the dispatch
 * namespace, at its `/internal/sync-config`. Any other tenant shares this
 * database, so it is synced in-process.
 *
 * Returns undefined when the dispatch namespace or the shared secret is not
 * configured, which leaves only the in-process sync (it refuses WFP tenants).
 */
function buildSyncDefaults(
  env: Env,
  rawAdapter: DataAdapters,
  dataAdapter: DataAdapters,
): SyncConfigFn | undefined {
  if (!env.DISPATCHER || !env.WFP_INTERNAL_SYNC_SECRET) return undefined;

  const dispatch = createDispatchSyncConfig({
    dispatcher: env.DISPATCHER,
    internalSecret: env.WFP_INTERNAL_SYNC_SECRET,
    controlPlaneTenantId: CONTROL_PLANE_TENANT_ID,
    // The layer that returns secrets as stored: ciphertext is copied, never
    // decrypted on the way.
    controlPlaneAdapters: rawAdapter,
  });
  const inProcess = createInProcessSyncConfig(dataAdapter, {
    controlPlaneTenantId: CONTROL_PLANE_TENANT_ID,
  });

  return async (tenantId, options) => {
    const tenant = await rawAdapter.tenants.get(tenantId);
    return tenant?.deployment_type === "wfp"
      ? dispatch(tenantId, options)
      : inProcess(tenantId, options);
  };
}
