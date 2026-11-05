import { drizzle } from "drizzle-orm/d1";
import createAdapters from "@authhero/drizzle";
import * as schema from "@authhero/drizzle/schema/sqlite";
import { HTTPException } from "hono/http-exception";
import { createWfpTenantApp } from "@authhero/cloudflare-adapter/wfp";
import {
  CustomDomainsAdapter,
  DataAdapters,
  createControlPlaneClient,
  createControlPlaneCustomDomainsAdapter,
  createServiceBindingFetch,
  createServiceTokenCore,
} from "authhero";
import { Env } from "./types";

// ──────────────────────────────────────────────────────────────────────────────
// What `createWfpTenantApp` gives this Worker, so none of it is wired here:
//
//   - key-ring encryption over this tenant's own D1: its own secrets under
//     ENCRYPTION_KEY, the control plane's rows under the "cp" key id
//     (CONTROL_PLANE_ENCRYPTION_KEY)
//   - runtime fallback to the control plane rows synced into this D1
//   - the control plane's receivers, authenticated with WFP_INTERNAL_SYNC_SECRET:
//       POST /internal/sync-config   the `sync-defaults` operation's resolved block
//       POST /internal/detach        the `detach` operation
//       POST /internal/sync-defaults the provisioning seed
//   - the control-plane issuer gate for forwarded admin tokens
//
// It reads ISSUER, TENANT_ID, CONTROL_PLANE_TENANT_ID and CONTROL_PLANE_ISSUER
// from the environment ([vars] in wrangler.toml), not from the request, so they
// are fixed for the life of the script.
//
// Data retention: no cron here — this is deliberate. This Worker is uploaded to
// a Workers-for-Platforms dispatch namespace and is only ever invoked via
// `env.DISPATCHER.get(name).fetch()`. Dispatch-namespace Workers do NOT receive
// `scheduled` events, so a `[triggers] crons` block here would never fire. Its D1
// (codes, outbox_events, expired sessions) must instead be swept centrally:
// iterate tenants from the control plane and call
// `runRetention({ dataAdapter, tenantId })` against each tenant's own database.
// See https://authhero.net/deployment/data-retention.
// ──────────────────────────────────────────────────────────────────────────────

export default createWfpTenantApp<Env>({
  createDataAdapter: (env) =>
    createAdapters(drizzle(env.AUTH_DB, { schema }), {
      useTransactions: false,
    }),

  // Log what read-time inheritance would give this tenant against what its own
  // database holds, as `cfgdiff` entries in the tenant's logs. Never changes a
  // response. It is the shadow check in the config-sync migration runbook.
  inheritanceShadow: true,

  configure: (base, env) => ({
    ...base,
    // The app is built once per isolate, so the origins are fixed rather than
    // echoed per request. Leave ALLOWED_ORIGINS unset to allow none.
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    dataAdapter: {
      ...base.dataAdapter,
      customDomains: buildCustomDomains(base.dataAdapter, env),
    },
  }),
});

/**
 * Custom domains are the one entity this Worker cannot own. Registering a
 * CF-for-SaaS hostname needs account credentials that only the control plane
 * holds, and "login.acme.com belongs to exactly one tenant" can only be
 * enforced above the shards. So writes go to the control plane synchronously
 * and the result is mirrored into this tenant's D1, which stays the read cache
 * that host resolution uses.
 */
function buildCustomDomains(
  shard: DataAdapters,
  env: Env,
): CustomDomainsAdapter {
  if (!env.CONTROL_PLANE_URL) {
    // Fail closed. Writing to the local table would "succeed" while the
    // hostname is registered nowhere and its uniqueness is unchecked — the
    // exact silent breakage this indirection exists to prevent. Reads still
    // work, so any domain already mirrored here keeps resolving.
    return readOnlyCustomDomains(shard.customDomains);
  }

  const client = createControlPlaneClient({
    baseUrl: env.CONTROL_PLANE_URL,
    // Prefer the service binding: this Worker runs inside the dispatch
    // namespace, so a public-edge call to the control plane would leave
    // Cloudflare and come back in through the proxy that dispatched us. The
    // binding keeps the hop internal (and cannot loop back into the proxy
    // regardless of what CONTROL_PLANE_URL points at). Without the binding we
    // fall back to the public edge, which still works.
    fetchImpl: env.CONTROL_PLANE
      ? createServiceBindingFetch(env.CONTROL_PLANE)
      : undefined,
    getServiceToken: async (tenantId, scope) => {
      const token = await createServiceTokenCore({
        tenants: shard.tenants,
        keys: shard.keys,
        tenantId,
        scope,
        issuer: env.ISSUER,
      });
      return token.access_token;
    },
  });

  return createControlPlaneCustomDomainsAdapter({
    client,
    mirror: shard.customDomains,
  });
}

/**
 * Custom-domain reads pass through; every write is refused. A tenant Worker
 * cannot register a Cloudflare hostname or check that nobody else claimed it,
 * so a "successful" local write would produce a domain that never routes.
 * Set CONTROL_PLANE_URL to enable writes.
 */
function readOnlyCustomDomains(
  mirror: CustomDomainsAdapter,
): CustomDomainsAdapter {
  const unconfigured = (): never => {
    throw new HTTPException(501, {
      message:
        "Custom domains are managed by the control plane: set CONTROL_PLANE_URL on this tenant Worker to create, update or delete them.",
    });
  };

  return {
    ...mirror,
    create: unconfigured,
    update: unconfigured,
    remove: unconfigured,
    uploadCertificate: unconfigured,
  };
}
