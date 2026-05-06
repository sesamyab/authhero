import { describe, expect, it, vi } from "vitest";
import {
  createCloudflareRateLimitAdapter,
  type CloudflareRateLimitBinding,
} from "../src/rate-limit";

const makeBinding = (
  outcomes: boolean[] | { throws: unknown },
): CloudflareRateLimitBinding & { calls: { key: string }[] } => {
  const calls: { key: string }[] = [];
  let i = 0;
  return {
    calls,
    async limit({ key }) {
      calls.push({ key });
      if ("throws" in outcomes) {
        throw outcomes.throws;
      }
      const success = outcomes[Math.min(i, outcomes.length - 1)] ?? true;
      i++;
      return { success };
    },
  };
};

describe("Cloudflare RateLimit adapter", () => {
  it("returns undefined when no bindings configured", () => {
    expect(createCloudflareRateLimitAdapter(undefined)).toBeUndefined();
    expect(createCloudflareRateLimitAdapter({})).toBeUndefined();
  });

  it("allows when scope has no binding", async () => {
    const adapter = createCloudflareRateLimitAdapter({
      "pre-login": makeBinding([true]),
    });
    expect(adapter).toBeDefined();
    const decision = await adapter!.consume("brute-force", "tenant:1.2.3.4");
    expect(decision).toEqual({ allowed: true });
  });

  it("forwards key to the configured binding and reports success", async () => {
    const binding = makeBinding([true]);
    const adapter = createCloudflareRateLimitAdapter({
      "pre-login": binding,
    });
    const decision = await adapter!.consume("pre-login", "tenant:1.2.3.4");
    expect(decision).toEqual({ allowed: true });
    expect(binding.calls).toEqual([{ key: "tenant:1.2.3.4" }]);
  });

  it("returns allowed=false when binding reports failure", async () => {
    const binding = makeBinding([false]);
    const adapter = createCloudflareRateLimitAdapter({
      "pre-login": binding,
    });
    const decision = await adapter!.consume("pre-login", "tenant:1.2.3.4");
    expect(decision.allowed).toBe(false);
  });

  it("fails open when the binding throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const binding = makeBinding({ throws: new Error("binding offline") });
    const adapter = createCloudflareRateLimitAdapter({
      "pre-login": binding,
    });
    const decision = await adapter!.consume("pre-login", "tenant:1.2.3.4");
    expect(decision).toEqual({ allowed: true });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("routes different scopes to different bindings", async () => {
    const preLogin = makeBinding([true]);
    const bruteForce = makeBinding([false]);
    const adapter = createCloudflareRateLimitAdapter({
      "pre-login": preLogin,
      "brute-force": bruteForce,
    });
    const a = await adapter!.consume("pre-login", "k1");
    const b = await adapter!.consume("brute-force", "k2");
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(false);
    expect(preLogin.calls).toEqual([{ key: "k1" }]);
    expect(bruteForce.calls).toEqual([{ key: "k2" }]);
  });
});
