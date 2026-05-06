/**
 * Logical buckets that consumers can rate-limit against. Backends decide
 * how each scope is enforced (e.g. mapping to a separate Cloudflare Workers
 * Rate Limiter binding with its own deploy-time limit/period).
 */
export type RateLimitScope =
  | "pre-login"
  | "pre-user-registration"
  | "brute-force";

export interface RateLimitDecision {
  /** True if the request is allowed; false if the limit was exceeded. */
  allowed: boolean;
  /** Optional retry-after hint in seconds (omitted if the backend can't tell). */
  retryAfterSeconds?: number;
}

export interface RateLimitAdapter {
  /**
   * Consume one unit of quota for the given scope and key.
   *
   * The numeric threshold and window are backend-specific; the
   * Cloudflare Workers Rate Limiter binding bakes them in at deploy
   * time and cannot honor a per-tenant override. Callers that need
   * per-tenant `max_attempts` should layer their own counter on top.
   *
   * Returns `{ allowed: true }` if the scope is not configured, so
   * callers can opt in by configuring backends without changing call
   * sites.
   */
  consume(scope: RateLimitScope, key: string): Promise<RateLimitDecision>;
}
