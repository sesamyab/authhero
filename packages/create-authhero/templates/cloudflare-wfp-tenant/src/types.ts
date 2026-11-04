/// <reference types="@cloudflare/workers-types" />

import type { WfpTenantEnv } from "@authhero/cloudflare-adapter/wfp";

/**
 * The bindings, variables and secrets of a tenant Worker. `WfpTenantEnv` is the
 * contract `createWfpTenantApp` reads; the rest is this template's own.
 *
 * Variables go in `[vars]` in wrangler.local.toml, secrets in `.dev.vars` for
 * local dev and in `--secrets-file` (or `wrangler secret put`) when deployed.
 */
export interface Env extends WfpTenantEnv {
  // This tenant's own D1 database. Each WFP tenant Worker has its own.
  AUTH_DB: D1Database;

  // Base64-encoded 32-byte key for this tenant's own secrets at rest.
  // Secret. Generate one with `npm run gen:key`.
  ENCRYPTION_KEY: string;

  // Base64-encoded 32-byte CONTROL PLANE key. Decrypts the shared secrets
  // (e.g. Google client_secret) that the control plane synced into this
  // tenant's database under the "cp" key id. Secret, and byte-identical to the
  // control plane's: without it a sync is refused with
  // 422 `sync_config_key_ring` and nothing is written.
  CONTROL_PLANE_ENCRYPTION_KEY?: string;

  // Shared secret the control plane sends as a bearer token to
  // /internal/sync-config. Secret, and identical to the control plane's: a push
  // that does not carry it answers 401.
  WFP_INTERNAL_SYNC_SECRET?: string;

  // This tenant's id, e.g. "acme". A push addressed to another tenant is
  // refused with 403 `sync_config_tenant_mismatch` before anything is read or
  // written. Variable.
  TENANT_ID?: string;

  // This tenant's own issuer (its JWT `iss`), with a trailing slash, e.g.
  // https://auth.acme.com/. Variable. Fixed for the life of the script: it is
  // not derived from the request.
  ISSUER: string;

  // Id of the control plane tenant whose rows this tenant inherits. Variable.
  // Must match the control plane Worker's CONTROL_PLANE_TENANT_ID.
  CONTROL_PLANE_TENANT_ID: string;

  // The control plane's own issuer, e.g. https://control.example.com/. Accepted
  // in addition to ISSUER for tokens the control plane minted, so its admin
  // tokens verify here. Variable.
  CONTROL_PLANE_ISSUER: string;

  // Base URL of the control-plane Worker, e.g. https://control.example.com.
  // When set, custom domains are written through the control plane (which
  // holds the Cloudflare account credentials and enforces cross-tenant
  // uniqueness) instead of only into this tenant's D1 — without it, a created
  // domain is never registered in Cloudflare and stays unroutable.
  CONTROL_PLANE_URL?: string;

  // Service binding to the control-plane Worker. Optional but recommended:
  // this Worker runs inside the dispatch namespace, so without the binding the
  // call to CONTROL_PLANE_URL goes out over the public edge and back in
  // through the proxy that dispatched us. The binding keeps it internal.
  // CONTROL_PLANE_URL is still required — it forms the request URL.
  CONTROL_PLANE?: Fetcher;

  // Comma-separated origins allowed for CORS, e.g. an admin UI. Variable.
  // Unset allows none.
  ALLOWED_ORIGINS?: string;
}
