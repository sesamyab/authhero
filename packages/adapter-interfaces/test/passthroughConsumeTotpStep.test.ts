import { describe, expect, it, vi } from "vitest";
import { createPassthroughAdapter } from "../src/utils/passthrough";

describe("createPassthroughAdapter consumeTotpStep", () => {
  it("mirrors consumeTotpStep to secondaries by default and returns the primary's result", async () => {
    const primary = {
      consumeTotpStep: vi.fn(async () => false),
      get: vi.fn(async () => null),
    };
    const secondary = {
      consumeTotpStep: vi.fn(async () => true),
      get: vi.fn(async () => null),
    };

    const adapter = createPassthroughAdapter({
      primary,
      secondaries: [{ adapter: secondary, blocking: true }],
    });

    // A replay rejected by the primary stays rejected.
    expect(await adapter.consumeTotpStep("tenantId", "method", 42)).toBe(false);
    expect(secondary.consumeTotpStep).toHaveBeenCalledWith(
      "tenantId",
      "method",
      42,
    );

    // Reads are still primary-only.
    await adapter.get("tenantId", "method");
    expect(secondary.get).not.toHaveBeenCalled();
  });
});
