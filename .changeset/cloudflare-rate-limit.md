---
"@authhero/adapter-interfaces": minor
"@authhero/cloudflare-adapter": minor
"authhero": minor
---

Add a `RateLimitAdapter` interface and an opt-in Cloudflare implementation
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
