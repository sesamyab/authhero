import type {
  RateLimitAdapter,
  RateLimitDecision,
  RateLimitScope,
} from "@authhero/adapter-interfaces";

/**
 * Minimal shape of the Cloudflare Workers Rate Limiter binding. We declare
 * it locally rather than depending on `@cloudflare/workers-types` so the
 * adapter package stays runtime-agnostic.
 *
 * Reference: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
 */
export interface CloudflareRateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Map of scopes to Cloudflare Workers Rate Limiter bindings. Each binding's
 * `limit` and `period` are configured at deploy time in `wrangler.toml` and
 * cannot be overridden per request.
 *
 * Workers Rate Limiter only supports `period: 10` or `period: 60` seconds —
 * it is a short-window burst guard, not a daily cap. For Auth0-style
 * thresholds (e.g. 100 attempts / day) see `FUTURE: Durable Object backend`
 * below.
 *
 * Any scope omitted from this map results in a permissive ("allowed: true")
 * decision so callers can configure backends incrementally.
 */
export type CloudflareRateLimitBindings = Partial<
  Record<RateLimitScope, CloudflareRateLimitBinding>
>;

class CloudflareRateLimit implements RateLimitAdapter {
  constructor(private bindings: CloudflareRateLimitBindings) {}

  async consume(
    scope: RateLimitScope,
    key: string,
  ): Promise<RateLimitDecision> {
    const binding = this.bindings[scope];
    if (!binding) {
      return { allowed: true };
    }

    try {
      const { success } = await binding.limit({ key });
      return { allowed: success };
    } catch (error) {
      // A misbehaving binding should never lock users out. Fail open and log.
      console.error(
        `CloudflareRateLimit: limit() error for scope ${scope}:`,
        error,
      );
      return { allowed: true };
    }
  }
}

export function createCloudflareRateLimitAdapter(
  bindings: CloudflareRateLimitBindings | undefined,
): RateLimitAdapter | undefined {
  if (!bindings) {
    return undefined;
  }
  const hasAny = (Object.keys(bindings) as RateLimitScope[]).some(
    (scope) => bindings[scope],
  );
  if (!hasAny) {
    return undefined;
  }
  return new CloudflareRateLimit(bindings);
}

/*
 * FUTURE: Durable Object backend
 *
 * The Workers Rate Limiter binding only supports 10s or 60s windows with a
 * static `limit`. To honor the per-tenant `max_attempts` and longer windows
 * modeled in the `attack_protection` tenant settings (Auth0 defaults are
 * ~100/day for pre-login and ~50/day for pre-user-registration), we'll add a
 * Durable Object–backed implementation:
 *
 *   - One DO instance per `${scope}:${tenantId}:${key}` (via idFromName).
 *   - DO keeps `count` + `resetAt` in storage; atomic increment, compares to
 *     the tenant's configured `max_attempts`, returns allowed/blocked plus
 *     `retryAfterSeconds`.
 *   - The Workers Rate Limiter binding stays in front as a cheap 60s burst
 *     guard so obvious floods never hit the DO.
 *   - Adapter shape stays the same; only `consume` internals change.
 *
 * Punted from the initial implementation to avoid the DO config + migration
 * surface area. Pick this up when a tenant actually needs custom thresholds.
 */
