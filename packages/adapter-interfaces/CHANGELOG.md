# @authhero/adapter-interfaces

## 1.15.0

### Minor Changes

- 639ab29: Add lazy-migration support from an upstream Auth0 tenant. Two flows are gated by the existing `connection.options.import_mode` flag (already part of the Auth0 connection schema):
  - **Password fallback** — when a `Username-Password-Authentication` connection has `import_mode: true`, password logins that miss locally (no user, or no matching hash) fall back to the upstream Auth0's password-realm grant. On success the user/profile is fetched from `/userinfo` and the bcrypt hash is stored locally so subsequent logins are served entirely from authhero. No M2M token required.
  - **Refresh-token proxy** — when a `strategy: "auth0"` connection has `import_mode: true`, refresh-token grant requests whose token doesn't match any local row are forwarded to the upstream `/oauth/token` and the response is relayed verbatim (rotation, error shapes, etc.). Existing Auth0 sessions keep working until the next interactive login migrates the user via the password-fallback path.

  Configuration uses standard `connections` records — no new tenant fields, no new management API routes. A new `Strategy.AUTH0 = "auth0"` value identifies the upstream-source connection (filtered out of the universal-login button list automatically). The connection's `options` re-uses existing fields: `token_endpoint`, `userinfo_endpoint`, `client_id`, `client_secret`, `import_mode`. The react-admin connection edit form gains a dedicated section for these fields when `strategy === "auth0"`.

## 1.14.0

### Minor Changes

- 85d1d06: Add `/login/callback` as the new path for the upstream connection callback. The existing `/callback` route continues to work but is now marked as deprecated in the OpenAPI spec.

  Connections can also override the redirect_uri sent to the upstream IdP via the new `options.callback_url` field. When set, the strategy uses that URL verbatim; when unset, it falls back to the legacy `${authUrl}callback`. This lets operators flip individual connections to `/login/callback` (or any other registered redirect URI) one at a time as they update each IdP's allowed redirect URIs — no big-bang migration required.

## 1.13.0

### Minor Changes

- e0cd449: Add Home Realm Discovery (HRD) via `domain_aliases` on connection options. When a user enters their email at the universal-login identifier prompt, authhero now looks for an enterprise/social connection whose `options.domain_aliases` contains the email's domain and, on a match, redirects straight to that IdP — skipping the password / OTP step.
  - New optional field: `Connection.options.domain_aliases: string[]` (Auth0-compatible, stored in the existing `options` JSON column — no DB migration).
  - Domain matching is case-insensitive and exact (no wildcards).
  - Only enterprise/social strategies are eligible; HRD ignores `domain_aliases` set on `Username-Password-Authentication`, `email`, or `sms` connections.
  - Domain match wins over an existing local-password user with the same email.
  - The react-admin connection edit form now exposes a Domain Aliases input on non-database connections.

- 86fe6e8: Support `private_key_jwt` and `client_secret_jwt` client authentication at `/oauth/token` (RFC 7523 §3 / OIDC Core §9). Clients can now authenticate by sending a signed JWT in `client_assertion` instead of a `client_secret`.

  How it works:
  - The client posts `client_assertion=<JWT>` and `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`. `client_id` may be sent as a form field or omitted (in which case it's derived from the assertion's `sub` claim).
  - For `private_key_jwt` (asymmetric), the assertion is verified against the client's `registration_metadata.jwks` (inline) or `client_metadata.jwks_uri` (fetched with the same SSRF guard used by request objects). RS256/RS384/RS512 + ES256/ES384/ES512 are accepted.
  - For `client_secret_jwt` (HMAC), the assertion is verified against the client's stored `client_secret`. HS256/HS384/HS512 are accepted.
  - The verifier enforces RFC 7523 claims: `iss == sub == client_id`, `aud` matching the token endpoint URL or the OP issuer, required `exp` (with 30 s leeway), optional `nbf`. `alg=none` is rejected.
  - Sending both `client_secret` and `client_assertion` is rejected with `invalid_request`.
  - All existing grants (authorization_code, client_credentials, refresh_token) honor the assertion: their `client_secret` comparison is skipped when the request authenticated via assertion. `code_verifier` (PKCE) still applies to the authorization-code grant when present.

  Schema / discovery:
  - `Client.token_endpoint_auth_method` now accepts `client_secret_jwt` and `private_key_jwt` alongside the existing values. Dynamic Client Registration accepts the same values for `token_endpoint_auth_method`.
  - Discovery's `token_endpoint_auth_methods_supported` now lists `["client_secret_basic", "client_secret_post", "client_secret_jwt", "private_key_jwt"]`.

  For replay protection, this release validates `exp` (and the optional `nbf`) but does not yet track `jti`. Most basic OIDC conformance test plans pass with `exp`-only; FAPI requires `jti` tracking, which can be added later as a separate change.

- 3891832: Support EC signing keys (ES256/ES384/ES512) for ID and access tokens. The signing algorithm is now derived from the key material at issue time, so a tenant can swap its `jwt_signing` key from RSA to EC P-256/P-384/P-521 (via `createX509Certificate({ keyType: "EC-P-256" })`) without changing any other configuration. RSA keys continue to sign with RS256.

  Discovery now advertises `id_token_signing_alg_values_supported: ["RS256", "ES256", "ES384", "ES512"]`, and `/.well-known/jwks.json` publishes EC keys with the proper `kty`/`crv`/`x`/`y` members and an explicit `alg`. The exported `jwksSchema` no longer requires `n` and `e` (those are now optional, alongside the new EC fields), so consumers narrowing on `kty` before reading members may need a small adjustment.

  PS256/PS384/PS512 are not yet supported; they require an explicit per-key alg field and will follow in a subsequent change.

### Patch Changes

- f41b85c: Verify signed Request Objects at `/authorize` (RFC 9101 / OIDC Core §6.1) and add support for `request_uri` (§6.2). Previously the `request=` JWT was decoded without checking its signature — any caller could forge claims and have them merged into the authorization request. That hole is now closed.

  Behaviour changes:
  - `request=` JWTs are signature-verified against the client's keys. `alg=none` (unsigned request objects) is rejected. HS256/HS384/HS512 verify against `client_secret`; RS*/ES* verify against the client's `registration_metadata.jwks` (inline) or `client_metadata.jwks_uri` (fetched). The verifier also enforces `iss == client_id` (when present), `aud` matching the OP issuer, and `exp`/`nbf` with 30s leeway.
  - `request_uri` is now accepted. The URL is fetched with an SSRF guard (https-only by default, blocks `localhost` and private/loopback/link-local IPv4 + IPv6 ranges, 5s timeout, 64 KiB body cap) and the JWT body runs through the same verifier.
  - Sending both `request` and `request_uri` is rejected with HTTP 400 per the spec.
  - Discovery now advertises `request_uri_parameter_supported: true` and adds `request_object_signing_alg_values_supported: ["RS256","RS384","RS512","ES256","ES384","ES512","HS256","HS384","HS512"]`.

  For tests/local development, set `ALLOW_PRIVATE_OUTBOUND_FETCH: true` on the env binding to relax the SSRF guard (allows `http://`, `localhost`, and private IPs).

## 1.12.0

### Minor Changes

- 32aacc6: Action secrets PATCH now preserves existing values when an incoming secret omits its `value` (matched by `name`). The `value` field is optional on writes so admin UIs can round-trip a masked secrets list without overwriting stored values.
- a4e29bd: Add a `RateLimitAdapter` interface and an opt-in Cloudflare implementation
  backed by the Workers Rate Limiter binding. The cloudflare adapter accepts
  `rateLimitBindings` (per-scope: `pre-login`, `pre-user-registration`,
  `brute-force`) and returns a `rateLimit` adapter when at least one binding
  is configured. Missing bindings or thrown errors fail open so a misconfigured
  deploy never locks users out.

  The password grant now consults `data.rateLimit?.consume("pre-login", ...)`
  keyed by `${tenantId}:${ip}` when the tenant has
  `suspicious_ip_throttling.enabled` and the IP is not in the allowlist. The
  Workers Rate Limiter only supports 10s/60s windows, so the configured
  `max_attempts` is intentionally not honored — see the Durable Object
  follow-up note in `packages/cloudflare/src/rate-limit/index.ts` for the
  plan to support tenant-tunable thresholds.

- 32aacc6: Capture `console.*` output from dynamic code hooks and emit a log entry for every execution.
  - Added `SUCCESS_HOOK` (`"sh"`) log type and a new `CodeExecutionLog` shape on `CodeExecutionResult.logs`.
  - The Cloudflare and Local executors now shadow `console` inside the sandbox and return up to 50 captured entries (each truncated to 500 chars) per execution.
  - `handleCodeHook` now writes a `SUCCESS_HOOK` log on success and a `FAILED_HOOK` log on failure, with `hook_id`, `code_id`, `trigger_id`, `duration_ms`, recorded `api_calls`, and the captured `logs` array on the log's `details` payload — surfacing dynamic-action execution in the tenant log feed for debugging.

- 6e5762c: Add `theme.page_background.logo_placement` (`widget` | `chip` | `none`) to control where the tenant logo renders on the universal-login page. Defaults to `widget` (the widget's own internal header). When set to `chip` or `none`, the widget's internal logo is suppressed via `theme.widget.logo_position = "none"` so there's no duplicate.
- 32aacc6: Add `default_client_id` to the tenant schema. `/connect/start` now prefers this client as the login_session anchor for tenant-level DCR consent flows, falling back to the first available client so a brand-new tenant can still bootstrap its first integration. Roughly analogous to Auth0's "Default App" / Global Client.

## 1.11.0

### Minor Changes

- 21b0608: Add Auth0-style refresh-token rotation and at-rest hashing.
  - New wire format `rt_<lookup>.<secret>`. The `lookup` slice is indexed in `refresh_tokens.token_lookup`; only the SHA-256 of the secret is persisted in `token_hash`. Internal ULID `id` stays as the primary key.
  - New per-client config in `Client.refresh_token`: `rotation_type: "rotating" | "non-rotating"` (default `non-rotating`) and `leeway` seconds (default 30). Set `rotation_type: "rotating"` to opt a client into rotation.
  - Each rotation issues a fresh child sharing `family_id` with the parent. Re-presenting a rotated parent within `leeway` mints a sibling (concurrent-call tolerance); outside `leeway` it triggers reuse detection and revokes the entire family via the new `revokeFamily` adapter method.
  - Admin `DELETE /api/v2/refresh_tokens/:id` now also revokes the rest of the family.
  - Backwards compatible: legacy id-only refresh tokens keep working until `2026-06-05`. After that date a follow-up PR removes the legacy fallback.

- ea5ec43: Add endpoints for organization connections
- 90e9906: Add `/api/v2/log-streams` and `/api/v2/attack-protection` management endpoints,
  and stop merging locale defaults into the GET response of
  `/api/v2/prompts/{prompt}/custom-text/{language}`. The terraform `auth0/auth0`
  provider can now drive log streams, attack-protection settings, and prompt
  custom text against authhero without the apply hanging on PUT/GET drift.

## 1.10.3

### Patch Changes

- e5cbfe7: Advertise `end_session_endpoint` in `/.well-known/openid-configuration` when the tenant flag `oidc_logout.rp_logout_end_session_endpoint_discovery` is enabled (off by default, matching Auth0). Required for OIDC RP-Initiated Logout. Also adds the optional `end_session_endpoint` field to the `openIDConfigurationSchema`.
- dd071e0: Add `Cache-Control: no-store` and `Pragma: no-cache` headers to the token endpoint response (per RFC 6749 §5.1) and advertise `grant_types_supported` in the OpenID Connect discovery document. Reject refresh-token exchanges where the refresh token's `client_id` does not match the authenticating client. Implement `POST /oauth/revoke` per RFC 7009 (refresh-token revocation, with `client_secret_basic` and `client_secret_post` client authentication).

## 1.10.2

### Patch Changes

- 3230b9b: Hook metadata bag + control-plane template inheritance.

  Adds a free-form `metadata: Record<string, unknown>` field to all hook variants (web, form, template, code), persisted as JSON in kysely + drizzle. Two well-known keys are defined:
  - `metadata.inheritable: true` — when set on a hook on the control-plane tenant, the multi-tenancy runtime fallback surfaces that hook on every sub-tenant's `hooks.list` and `hooks.get`. Inherited hooks are read-only from the sub-tenant's perspective: writes go through the base adapter's `tenant_id` WHERE clause and are silent no-ops on cross-tenant rows.
  - Template options. The dispatcher forwards `hook.metadata` to the template function. The `account-linking` template reads `metadata.copy_user_metadata: true` to merge the secondary user's `user_metadata` into the primary's on link (primary wins on key conflicts; `app_metadata` is never copied).

  Includes the kysely migration `2026-04-29T10:00:00_hooks_metadata` adding the `metadata` column.

## 1.10.1

### Patch Changes

- 4d06f0d: Make user linking opt-in via the `account-linking` template hook.

  The legacy `linkUsersHook` has been renamed to `commitUserHook` and the email-based primary-user lookup is now an explicit option (`resolveEmailLinkedPrimary`). Whether it runs is controlled by:
  - A new service-level `userLinkingMode` option on `init()` — `"builtin"` (default, current behaviour) or `"off"` (template only). The template hook is controlled independently via the management API regardless of mode.
  - A per-client `user_linking_mode` field on the `Client` schema that overrides the service-level default for a single application — useful for validating the template-driven path on one client before flipping the whole tenant.

  The `account-linking` template hook is now a registered template (`template_id: "account-linking"`) and supports three triggers: `post-user-login` (existing), `post-user-registration`, and `post-user-update`. Tenants enable it via the management API:

  ```json
  {
    "trigger_id": "post-user-registration",
    "template_id": "account-linking",
    "enabled": true
  }
  ```

  `hookTemplates[<id>].trigger_id` (singular) is now `trigger_ids` (array) to support multi-trigger templates.

  Adds the kysely migration `2026-04-28T10:00:00_client_user_linking_mode` and extends the drizzle clients schema to add the `user_linking_mode` column.

## 1.10.0

### Minor Changes

- ba03e14: Drop `dcr_allowed_integration_types` tenant flag and per-tenant allowlist check on `/connect/start`. `integration_type` is now an optional free-form label — `enable_dynamic_client_registration` alone gates the connect flow. Existing callers that pass `integration_type` continue to work; the value still flows into the IAT constraints and consent screen when supplied.

## 1.9.0

### Minor Changes

- 2578652: Allow http `return_to` on `/connect/start` for loopback hosts and tenant-allowlisted dev origins.

  `GET /connect/start` previously required `return_to` to be `https://<domain>` and rejected all `http://` schemes. That broke local-dev integrators (e.g. WordPress under `wp-env` at `http://127.0.0.1:8888`).

  The new rule:
  - HTTPS is always permitted (no behavior change).
  - HTTP is permitted iff:
    1. The host is loopback — `localhost`, `127.0.0.1`, or `[::1]` (any port). Aligned with RFC 8252 §7.3.
    2. The exact origin (scheme + host + port) appears in the new tenant flag `allow_http_return_to`.
  - `0.0.0.0` is always rejected; `localhost.<anything>` is not pattern-matched; trailing dots and case variations are normalized.
  - `domain` and `return_to` still must agree on scheme + host + port. `domain` may now be passed as a fully-qualified origin (`http://127.0.0.1:8888`); bare host[:port] continues to mean implicit `https://`.

  The consent screen at `/u2/connect/start` shows a "Local development" badge when `domain` is loopback or matches the tenant allowlist, so a user can spot a phishing attempt that claims a `localhost` callback they didn't initiate.

  A new `flags.allow_http_return_to: string[]` field is added to the tenant schema. Default `[]`. Each entry must be a fully-qualified `http://` origin with no path/query/fragment; malformed entries are rejected on write.

## 1.8.0

### Minor Changes

- 02cebf4: Add RFC 7591 Dynamic Client Registration and RFC 7592 Client Configuration endpoints with Initial Access Token support.
  - `POST /oidc/register` (RFC 7591 §3): create a client, optionally gated by an Initial Access Token (IAT). Open DCR can be enabled by setting `tenant.flags.dcr_require_initial_access_token = false`.
  - `GET/PUT/DELETE /oidc/register/:client_id` (RFC 7592): self-service client configuration using the registration access token returned at registration time.
  - New `client_registration_tokens` table (kysely + drizzle) holding both IATs and RATs with SHA-256 hashed storage.
  - New `clients` columns: `owner_user_id`, `registration_type`, `registration_metadata`.
  - New tenant flags: `dcr_require_initial_access_token`, `dcr_allowed_grant_types`.
  - Discovery (`.well-known/openid-configuration`) now only emits `registration_endpoint` when `flags.enable_dynamic_client_registration = true`.
  - RFC 7591 `redirect_uris` is mapped to/from AuthHero's internal `callbacks` field at the wire boundary — the Management API continues to use `callbacks` unchanged.

### Patch Changes

- 48eab09: Add Phases 4 and 5 of RFC 7591/7592 Dynamic Client Registration.

  **Phase 4 — consent-mediated DCR**
  - New top-level `GET /connect/start?integration_type=...&domain=...&return_to=...&state=...&scope=...` route validates the request, creates a login session, and 302s to `/u2/connect/start`. The Stencil widget renders a consent screen there; on confirm AuthHero mints an IAT bound to the consenting user (with `domain`, `integration_type`, `scope`, and `grant_types: ["client_credentials"]` as pre-bound constraints) and redirects to `return_to?authhero_iat=<token>&state=<state>`. Cancel returns `authhero_error=cancelled`.
  - New `POST /api/v2/client-registration-tokens` (scope `create:client_registration_tokens` or `auth:write`) for non-browser IAT issuance. Body: `{ sub?, constraints?, expires_in_seconds?, single_use? }` — defaults to 5-minute TTL and single-use.
  - New tenant flag `dcr_allowed_integration_types: string[]` allowlists the `integration_type` values accepted by `/connect/start`.
  - New management scope `create:client_registration_tokens` added to `MANAGEMENT_API_SCOPES`.

  **Phase 5 — owner scoping & soft-delete enforcement**
  - New `GET /api/v2/users/{user_id}/connected-clients` Management API endpoint returns clients owned by a user (created via IAT-gated DCR). Response is a slim projection — no secrets, no internal config — and excludes soft-deleted clients.
  - `getEnrichedClient` now treats clients with `client_metadata.status === "deleted"` as not found. After RFC 7592 `DELETE /oidc/register/{client_id}`, subsequent `/oauth/token`, `/authorize`, and resume requests for that `client_id` are rejected.
  - The kysely `clients.list` adapter now supports lucene-style `field:"value"` exact-match filtering on `owner_user_id` and `registration_type`.

## 1.7.0

### Minor Changes

- 9145dbd: Preserve `user_id`, `audience`, and `scope` on outbox-delivered log entries. Previously, when `logMessage` was routed through the outbox (e.g., successful login via `post-user-login` hook), the `AuditEvent` → `LogInsert` transform dropped these fields: `actor.id` ignored `params.userId` in favor of only `ctx.var.user_id`, and `audience` was hardcoded to `""` because the `AuditEvent` schema lacked those fields.
  - Add optional `audience` and `scope` to `AuditEventInsert`.
  - `buildAuditEvent` now falls back `actor.id` to `params.userId`, sets `actor.type = "user"` for user-initiated events, and categorizes them as `"user_action"`.
  - `toLogInsert` maps `event.audience` and `event.scope` through to the log row.

- 9145dbd: Drop the multi-statement transaction from `refreshTokens.update`. The previous implementation ran UPDATE + SELECT + UPDATE inside `db.transaction()` to extend the parent `login_session` expiry, which on async HTTP drivers (PlanetScale, D1) meant three sequential round-trips plus BEGIN/COMMIT and held a row lock on `login_sessions` across the whole transaction — creating a hot-row hotspot when multiple refresh tokens shared a `login_id`.
  - Add optional `UpdateRefreshTokenOptions.loginSessionBump` to the adapter interface. The caller now provides `login_id` and the pre-computed new `expires_at`, so the adapter avoids a read-before-write.
  - `refreshTokens.update` issues the refresh-token and login-session UPDATEs concurrently via `Promise.all`, collapsing wall-clock latency to roughly one round-trip on async drivers. The bump is idempotent (`WHERE expires_at_ts < new`) and self-healing (next refresh re-bumps on a transient failure), so strict atomicity is not required.
  - Fix `ctx.req.header["x-real-ip"]` / `["user-agent"]` — Hono exposes `header` as a function, so bracket access has been silently writing empty strings to `device.last_ip` / `device.last_user_agent` since the grant landed. Use `ctx.req.header("x-real-ip")` and skip the `device` write entirely when IP and UA are unchanged.

## 1.6.0

### Minor Changes

- 7d9f138: Soft-revoke refresh tokens instead of hard-deleting them. Adds a `revoked_at` field to the `RefreshToken` schema, a `revokeByLoginSession(tenant_id, login_session_id, revoked_at)` adapter method, and a `refresh_tokens.revoked_at_ts` column. The logout route now issues a single bulk UPDATE (fixing a pagination bug where sessions with >100 refresh tokens were not fully revoked), and the refresh-token grant rejects revoked tokens with an `invalid_grant` error.

## 1.5.0

### Minor Changes

- 931f598: Add `GET /authorize/resume` endpoint mirroring Auth0's terminal login-session resumption point.

  Sub-flows now persist the authenticated identity onto the login session (new `auth_strategy` and `authenticated_at` columns on `login_sessions`) and 302 the browser to `/authorize/resume?state=…`. The resume endpoint owns (a) hopping back to the original authorization host when the browser is on the wrong custom domain so the session cookie lands under the right wildcard, and (b) dispatching based on the login-session state machine to the final token/code issuance or to the next MFA/continuation screen.

  The social OAuth callback is migrated as the first consumer: the old 307-POST cross-domain re-dispatch in `connectionCallback` is replaced by a plain 302 to `/authorize/resume`, and the OAuth code exchange now always runs once on whichever host the provider called back to. Subsequent PRs will migrate the password / OTP / signup / SAML sub-flows to the same pattern, after which the ad-hoc `Set-Cookie` forwarding layers in Universal Login can be removed.

## 1.4.1

### Patch Changes

- 1d15292: Hide `registration_completed_at` from management API responses and hook payloads. The field is internal — used only by the self-healing post-user-registration re-enqueue logic — and is now stripped from `auth0UserResponseSchema`, the `GET/PATCH /users/:user_id` responses, all webhook bodies (via `invokeHooks`), the outbox `target.after` payload, and the `onExecutePostLogin` / `onExecutePreUserUpdate` / `onExecutePre|PostUserDeletion` event objects.

## 1.4.0

### Minor Changes

- d84cb2f: Complete the transaction fixes

## 1.3.0

### Minor Changes

- 2f6354d: Make session lifetime cofigurable

## 1.2.0

### Minor Changes

- b2aff48: Durable post-hooks with self-healing and dead-letter support.
  - Moved post-user-registration and post-user-deletion webhook delivery from inline invocation to the outbox, with `Idempotency-Key: {event.id}` headers and retry-with-backoff.
  - `EventDestination` gained an optional `accepts(event)` filter so `LogsDestination`, `WebhookDestination`, and `RegistrationFinalizerDestination` can share the same event stream without cross-writing.
  - Added `outbox.deadLetter`, `listFailed`, and `replay` to `OutboxAdapter`; the relay now moves exhausted events to dead-letter instead of silently marking them processed.
  - New `GET /api/v2/failed-events` and `POST /api/v2/failed-events/:id/retry` management endpoints for operating the dead-letter queue.
  - Self-healing: added `registration_completed_at` to the user; set by `RegistrationFinalizerDestination` (outbox path) or inline after successful synchronous webhook dispatch. `postUserLoginHook` re-enqueues the post-user-registration event on the next login when the flag is still null, so transient delivery failures recover automatically.
  - Removed the global management-api transaction middleware: pre-registration webhooks and user-authored action code no longer execute inside a held DB transaction. Individual write paths own their own atomicity (see `linkUsersHook`, `createUserUpdateHooks`, `createUserDeletionHooks`).
  - Added `users.rawCreate` to the adapter interface so the registration commit path can write without re-entering decorator hooks.
  - New `account-linking` pre-defined post-login hook (`preDefinedHooks.accountLinking`) and corresponding template, matching Auth0's marketplace linking action. Idempotent: re-running on every login is safe.
  - Non-Workers runtimes (Node, tests) now flush background promises via the outbox middleware so `waitUntil`-scheduled work completes before the response returns.

## 1.1.0

### Minor Changes

- 3da602c: Trim transactions

## 1.0.0

### Major Changes

- 20d5140: Add support for dynamic code

  BREAKING CHANGE: `DataAdapters` now requires a `hookCode: HookCodeAdapter` property. Adapters implementing `DataAdapters` must provide a `hookCode` adapter with `create`, `get`, `update`, and `remove` methods for managing hook code storage. See `packages/kysely/src/hook-code/` for a reference implementation.

## 0.155.0

### Minor Changes

- a59a49b: Implement disable-sso

## 0.154.0

### Minor Changes

- fa7ce07: Updates for passkeys login

## 0.153.0

### Minor Changes

- 884e950: Update outbox

## 0.152.0

### Minor Changes

- f3b910c: Add outbox pattern

## 0.151.0

### Minor Changes

- 3e74dea: Update handling of host headers
- 022f12f: Move email and sms to adapters

## 0.150.0

### Minor Changes

- 164fe2c: Added passkeys

## 0.149.0

### Minor Changes

- 64e858a: Add mfa with logging

## 0.148.0

### Minor Changes

- 469c395: Language refactor

## 0.147.0

### Minor Changes

- 5e73f56: Remove magic strings
- 5e73f56: Replace magic strings

## 0.146.0

### Minor Changes

- 318fcf9: Update widget links
- 318fcf9: Update widget links

## 0.145.0

### Minor Changes

- 30b5be1: Add support for set_user_root_attributes

## 0.144.0

### Minor Changes

- dcbd1d7: Store the used connection on the login_session

## 0.143.0

### Minor Changes

- 39df1aa: Change url of enter-code page

## 0.142.0

### Minor Changes

- 1a72b93: Added error pages and fixed provider user id

## 0.141.0

### Minor Changes

- 3de697d: Add support for http validation of domains

## 0.140.0

### Minor Changes

- 7154fe1: Update refresh-tokens schema

## 0.139.0

### Minor Changes

- 2617efb: Update stylig for widget

## 0.138.0

### Minor Changes

- 192f480: First step in refresh tokens refactor

## 0.137.0

### Minor Changes

- 0719de4: Add username to indetifier array

## 0.136.0

### Minor Changes

- d7bcd19: Add hook templates

## 0.135.0

### Minor Changes

- 65321b7: Update for forms, flows and u2 login

## 0.134.0

### Minor Changes

- a5c1ba9: Add mfa signup

## 0.133.0

### Minor Changes

- 7adc7dc: Add the password fields to the connection entity

## 0.132.0

### Minor Changes

- 131ea43: Add more node fields

## 0.131.0

### Minor Changes

- c5935bd: Update the new widget endpoints

## 0.130.0

### Minor Changes

- ac8af37: Add custom text support

## 0.129.0

### Minor Changes

- a8e70e6: Update schemas to remove old fallbacks

## 0.128.0

### Minor Changes

- 6585906: Move universal login templates to separate adapter

## 0.127.0

### Minor Changes

- fd374a9: Set theme id
- 8150432: Replaced legacy client

## 0.126.0

### Minor Changes

- 154993d: Improve react-admin experience by clearing caches and setting cores

## 0.125.0

### Minor Changes

- 491842a: Bump packages to make sure the universal_login_templates is available

## 0.124.0

### Minor Changes

- 2af900c: Create a per user session cleanup
- 2be02f8: Add dynamic liquid templates

## 0.123.0

### Minor Changes

- 2d0a7f4: Add a auth0-conformance flag

## 0.122.0

### Minor Changes

- 9d6cfb8: Wrap adapters as part of the multi-tenant package

## 0.121.0

### Minor Changes

- 2853db0: Only show the selected connections for a client
- 967d470: Add a metadata field to roles and resource-servers

## 0.120.0

### Minor Changes

- 00d2f83: Update versions to get latest build

## 0.119.0

### Minor Changes

- 8ab8c0b: Start adding xstate

## 0.118.0

### Minor Changes

- b7bb663: Make organizations lowercase

## 0.117.0

### Minor Changes

- 8611a98: Improve the multi-tenancy setup

## 0.116.0

### Minor Changes

- 9c15354: Remove shadcn and updated widget

## 0.115.0

### Minor Changes

- f738edf: Add checkpoint pagination for organizations

## 0.114.0

### Minor Changes

- 17d73eb: Change name of organization flag and add OR support in lucence queries
- e542773: Fixes for syncing resources servers and global roles

## 0.113.0

### Minor Changes

- d967833: Add a stencil-js widget for login

## 0.112.0

### Minor Changes

- ae8553a: Add is_system to all adapters

## 0.111.0

### Minor Changes

- 906337d: Add flows support

## 0.110.0

### Minor Changes

- a108525: Add flows

## 0.109.0

### Minor Changes

- 1bec131: Add stats endpoints and activity view

## 0.108.0

### Minor Changes

- 0e906aa: Generalize the base adapter

## 0.107.0

### Minor Changes

- 212f5c6: Update the connection schema for password strength

## 0.106.0

### Minor Changes

- f37644f: Update the node types for the forms

## 0.105.0

### Minor Changes

- 40caf1a: Add support for different connections for different clients. And support sorting.

## 0.104.0

### Minor Changes

- 125dbb9: Flow updates

## 0.103.0

### Minor Changes

- b0c4421: Add oidc and icon_url
- c96d83b: Added dispaly name on connections

## 0.102.0

### Minor Changes

- 0566155: Get provider from connection
- 0566155: Remove country 3 and country name fields

## 0.101.0

### Minor Changes

- 0ffb5ca: Add support for password strength

## 0.100.0

### Minor Changes

- 3a0d8ee: Add geo info

## 0.99.0

### Minor Changes

- a3c69f0: Add support for logs with cloudflare sql

## 0.98.0

### Minor Changes

- 6067f00: Update the hook names

## 0.97.0

### Minor Changes

- Update the logs schemas

## 0.96.0

### Minor Changes

- Added invites

## 0.95.0

### Minor Changes

- Merge settings and tenants table

## 0.94.0

### Minor Changes

- Add settings endpoint

## 0.93.0

### Minor Changes

- Add new events and update chadcn layout

## 0.92.0

### Minor Changes

- Remove disable signup from legacy client

## 0.91.0

### Minor Changes

- 149ab91: Drop the old application table
- b0e9595: Add client grants

## 0.90.0

### Minor Changes

- Update to use new clients

## 0.89.0

### Minor Changes

- Create new clients table

## 0.88.0

### Minor Changes

- Changed to LegacyClient as a first step in the refactor

## 0.87.0

### Minor Changes

- Get organizations crud working like auth0

## 0.86.0

### Minor Changes

- Add users to organizations

## 0.85.0

### Minor Changes

- Added organizations

## 0.84.0

### Minor Changes

- Add cache adapter

## 0.83.0

### Minor Changes

- Add type to keys

## 0.82.0

### Minor Changes

- Add user roles

## 0.81.0

### Minor Changes

- fc8153d: Update structure and endpoints

## 0.80.0

### Minor Changes

- Add roles

## 0.79.0

### Minor Changes

- Add resource servers, rules and permissions

## 0.78.0

### Minor Changes

- Remove vendorsettings

## 0.77.0

### Minor Changes

- Add client_metadata to client type

## 0.76.0

### Minor Changes

- Update the themes entity

## 0.75.0

### Minor Changes

- Add themes endpoints

## 0.74.0

### Minor Changes

- Refactor log types

## 0.73.0

### Minor Changes

- Use countrycode from vendor settings if available

## 0.72.0

### Minor Changes

- Add text form component

## 0.71.0

### Minor Changes

- Preserve app_metadata fields during /u/check-account; guard updating app_metadata.strategy; add test.

## 0.70.0

### Minor Changes

- Added state and nonce to codes

## 0.69.0

### Minor Changes

- Add redirect_uri to codes

## 0.68.0

### Minor Changes

- Add code_challenge to codes table

## 0.67.0

### Minor Changes

## 0.66.0

### Minor Changes

- Add a login_completed flag to the login sessions

## 0.65.0

### Minor Changes

- Add a form_id property to hooks

## 0.64.0

### Minor Changes

- Add form components schemas

## 0.63.0

### Minor Changes

- Update forms schema

## 0.62.0

### Minor Changes

- Update the forms fileds

## 0.61.0

### Minor Changes

- Add forms

## 0.60.0

### Minor Changes

- Update the post users

## 0.59.0

### Minor Changes

- Separated the connections option schema

## 0.58.0

### Minor Changes

- Create sms users

## 0.57.0

### Minor Changes

- Add a otp grant flow for token

## 0.56.0

### Minor Changes

- Sms support

## 0.55.0

### Minor Changes

- Add a getByDomain function for cutsom domains and a tenant-id middleware

## 0.54.0

### Minor Changes

- Add domain verification info

## 0.53.0

### Minor Changes

- Make the cloudflare custom domains adapter use another adpater for storage

## 0.52.0

### Minor Changes

- Set the session id on login sessions

## 0.51.0

### Minor Changes

## 0.50.0

### Minor Changes

- Add an optional session refrence to login_sessions and cleanup old tables

## 0.49.0

### Minor Changes

## 0.48.0

### Minor Changes

- Get passwords can return nul

## 0.47.0

### Minor Changes

- Add custom domains table and adapter

## 0.46.0

### Minor Changes

- Handle expires at for sessions

## 0.45.0

### Minor Changes

- Update entities for sessions and refresh tokens

## 0.44.0

### Minor Changes

- Recreate the tables for sessions and refresh tokens

## 0.43.0

### Minor Changes

- make it possible to create a tenant with an id

## 0.42.0

### Minor Changes

- Update session entity

## 0.41.0

### Minor Changes

- 23c2899: Use default audience from tenant for refresh token

## 0.40.0

### Minor Changes

- Add refresh tokens to jwt

## 0.39.0

### Minor Changes

- Store refresh tokesn

## 0.38.0

### Minor Changes

- Add table for refresh tokens

## 0.37.0

### Minor Changes

- Optimized bundles

## 0.36.0

### Minor Changes

- use default listparams

## 0.35.0

### Minor Changes

- migrate connection auth
- a0a18c9: move most of authorize endpoint

## 0.34.0

### Minor Changes

- add password routes

## 0.33.0

### Minor Changes

- add sendgrid and postmark mail services
- migrate dbconnections and setup email providers

## 0.32.1

### Patch Changes

- update all build packages

## 0.32.0

### Minor Changes

- add hooks to add claims to token

## 0.31.0

### Minor Changes

- set used_at for codes

## 0.30.0

### Minor Changes

- fix incorrect imports

## 0.29.1

### Patch Changes

## 0.29.0

### Minor Changes

- add silent tokens

## 0.28.0

### Minor Changes

- switch back to native enum

## 0.27.0

### Minor Changes

- moved token types from the interfaces to the authhero package

## 0.26.0

### Minor Changes

- add ip to logins table

## 0.25.0

### Minor Changes

- added email providers and removed tickets
- Added email providers

## 0.24.0

### Minor Changes

- add code verifier to codes table

## 0.23.0

### Minor Changes

- make strategy mandatory for connections

## 0.22.1

### Patch Changes

- remove the iife build files

## 0.22.0

### Minor Changes

- Get the demo project rendering

## 0.21.0

### Minor Changes

- Added a act-as property to the auth params

## 0.20.3

### Patch Changes

- Expose the migration script for kysely and add authhero test

## 0.20.2

### Patch Changes

- Update packages

## 0.20.1

### Patch Changes

- Add prompt to login sessions

## 0.20.0

### Minor Changes

- Add ui_locales to authparams

## 0.19.0

### Minor Changes

- Add freja as connection type

## 0.18.0

### Minor Changes

- Expose app_metadata and user_metadata

## 0.17.1

### Patch Changes

- Add missing properties

## 0.17.0

### Minor Changes

- Change to use a json field for connection options

### Patch Changes

- Add more properties to connection options

## 0.16.0

### Minor Changes

- Remove old properties of connections

## 0.15.6

### Patch Changes

- Change the allowed_clients on the application to be string in kysely and array of strings in interfaces

## 0.15.5

### Patch Changes

- Changed so promptsetting uses a partial for the update

## 0.15.4

### Patch Changes

- Change order of default and optional

## 0.15.3

### Patch Changes

- Make properties with defaults optional

## 0.15.2

### Patch Changes

- Make application default to empty arrays and a nanoid for secret

## 0.15.1

### Patch Changes

- Make options optional

## 0.15.0

### Minor Changes

- Add prompt settings and update the connection entity
- Add prompt settings adapter

## 0.14.0

### Minor Changes

- Refine the jswks typs

## 0.13.0

### Minor Changes

- Remove certificate type
- Remove the certificate type and add new update method

## 0.12.0

### Minor Changes

- Updated the certificate entity

### Patch Changes

- Made certificate properties optional

## 0.11.9

### Patch Changes

- Remove the otp table

## 0.11.8

### Patch Changes

- Removed unused tables

## 0.11.7

### Patch Changes

- Add the user id to the codes entity

## 0.11.6

### Patch Changes

- Rebuilt the interfaces

## 0.11.5

### Patch Changes

- Added a connection_id property to the codes

## 0.11.4

### Patch Changes

- Add samlp specific validation for application

## 0.11.3

### Patch Changes

- Simplify client

## 0.11.2

### Patch Changes

- Refactor applications and clients

## 0.11.1

### Patch Changes

- Update the application types

## 0.11.0

### Minor Changes

- Add the addons property

### Patch Changes

- Update the applications schema to handle addOns

## 0.10.5

### Patch Changes

- Added pre-user-signup hook type

## 0.10.4

### Patch Changes

- Add more log types

## 0.10.3

### Patch Changes

- Handle boolean values

## 0.10.2

### Patch Changes

- Fix typo in property

## 0.10.1

### Patch Changes

- Add properties to hooks

## 0.10.0

### Minor Changes

- Updated the types for logins and fixed the packaging for authhero

## 0.9.2

### Patch Changes

- Fix plural on the logins adapter

## 0.9.1

### Patch Changes

- Centralized all codes to the codes table and added a new logins table for the login sessions. The old tables will be removed in the next update

## 0.9.0

### Minor Changes

- Added themes and changed primary key for sessions

## 0.8.0

### Minor Changes

- Moved bcrypt out of adapter

## 0.7.0

### Minor Changes

- Updated the builds and d.ts files

## 0.6.0

### Minor Changes

- Added a package for kysely

## 0.5.3

### Patch Changes

- Change the otp to be code or link

## 0.5.2

### Patch Changes

- 3625688: Build client adapters

## 0.5.1

### Patch Changes

- Add plural s to clients

## 0.5.0

### Minor Changes

- Add a temporary client adapter until we can pass the tenant_id

## 0.4.0

### Minor Changes

- Update the adapters
- Update the OTP entity to not include the client_id and tenant_id

## 0.3.1

### Patch Changes

- Created a new build for the adapters

## 0.3.0

### Minor Changes

- Updated the adapter for otps

## 0.2.2

### Patch Changes

- Missed doing a manula build

## 0.2.1

### Patch Changes

- Added missing exports, updated readme

## 0.2.0

### Minor Changes

- Update the Session and UniversalLoginSession adapter

## 0.1.3

### Patch Changes

- Add typescritpt types

## 0.1.2

### Patch Changes

- Update package json with correct path to artefacts

## 0.1.1

### Patch Changes

- Fixed the npm publishing so it's only including the dist folder

## 0.1.0

### Minor Changes

- Added package for apapter interfaces
