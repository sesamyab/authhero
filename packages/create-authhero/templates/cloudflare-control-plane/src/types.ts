/// <reference types="@cloudflare/workers-types" />

export interface Env {
  // The control plane's shared database (also home to colocated tenants).
  AUTH_DB: D1Database;

  // The issuer apex, with a trailing slash, e.g. https://token.example.com/.
  // Variable. Hosts under it are tenant subdomains. Leave unset only while this
  // database holds a single tenant; otherwise set it to an apex that is not this
  // Worker's own host, and give this host a custom_domains row for the control
  // plane tenant. See the "Resolving the control plane tenant" section of the
  // README.
  ISSUER?: string;

  // Comma-separated origins allowed for CORS on the management API, e.g. the
  // admin UI's origin. Variable. List the admin UI here: the management API also
  // checks clients' web_origins, but of different tenants on the preflight and
  // on the call, so it is not a substitute.
  ALLOWED_ORIGINS?: string;

  // Base64-encoded 32-byte key for the control plane's own secrets at rest.
  ENCRYPTION_KEY?: string;

  // Base64-encoded 32-byte key (key id "cp") that the control plane tenant's
  // secrets are encrypted under. A sync copies that ciphertext into a tenant's
  // database as stored, and the tenant Worker holds the same key to decrypt it.
  CONTROL_PLANE_ENCRYPTION_KEY?: string;

  // The dispatch namespace the tenant Workers live in. Required to sync a
  // tenant that has its own Worker and database (`deployment_type: "wfp"`):
  // the sync is pushed to the Worker's `/internal/sync-config` through it.
  DISPATCHER?: DispatchNamespace;

  // Shared secret the tenant Workers check on `/internal/sync-config`, sent as
  // a bearer token. Must be identical on the control plane and every tenant
  // Worker, otherwise a push answers 401.
  WFP_INTERNAL_SYNC_SECRET?: string;

  // Cloudflare for SaaS credentials for the zone that fronts every tenant's
  // custom domains. They live here and nowhere else: registering a custom
  // hostname is an account-level operation, so tenant Workers delegate it to
  // this Worker. Without all three, the /custom-domains resource is not
  // mounted and tenants cannot register domains.
  CLOUDFLARE_ZONE_ID?: string;
  CLOUDFLARE_API_KEY?: string;
  CLOUDFLARE_API_EMAIL?: string;
  // Set to "true" on an Enterprise zone. Enterprise zones can stamp the owning
  // tenant onto each custom hostname, which is what lets the adapter tell "this
  // hostname is ours to adopt" from "this one belongs to somebody else". Left
  // unset, every ownership check falls back to the hostname being unique across
  // the zone, which is true but cannot detect drift.
  CLOUDFLARE_ZONE_ENTERPRISE?: string;
}
