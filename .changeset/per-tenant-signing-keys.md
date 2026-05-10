---
"@authhero/adapter-interfaces": minor
"@authhero/kysely-adapter": patch
"authhero": minor
---

Add opt-in per-tenant signing keys with control-plane fallback.

- `SigningKey` gains an optional `tenant_id` field. Existing rows (where `tenant_id IS NULL`) are treated as the shared control-plane bucket — no migration needed.
- The kysely keys adapter now exposes `tenant_id` as a filterable lucene field (e.g. `q: "type:jwt_signing AND tenant_id:foo"`, or `-_exists_:tenant_id` for the control-plane bucket).
- New `signingKeyMode` config in `init({ ... })` accepts `"control-plane" | "tenant"` or a resolver `({ tenant_id }) => …`. Mirrors the `userLinkingMode` pattern so tenants can be migrated one at a time. Default is `"control-plane"`, preserving the legacy behavior where every tenant shares one key pool.
- When a tenant resolves to `"tenant"`, signing prefers the tenant's own key and falls back to the control-plane key if the tenant has no non-revoked key yet. JWKS for that tenant publishes the union of both buckets so tokens minted by either still verify during rollout.
- The management API `GET /signing`, `POST /signing/rotate`, `PUT /signing/{kid}/revoke`, and `GET /signing/{kid}` now scope to the `tenant-id` header. Rotating with a tenant header revokes only that tenant's keys and mints the new key with `tenant_id` set; calls without the header continue to operate on the control-plane bucket.

Transitional: once every tenant has its own key, `signingKeyMode`, the control-plane fallback, and the legacy `tenant_id IS NULL` bucket can be removed.
