import { describe, expect, it, vi } from "vitest";
import { createPassthroughAdapter } from "../src/utils/passthrough";

describe("createPassthroughAdapter updateIfStateDataUnchanged", () => {
  function setup(primaryAccepts: boolean) {
    const primary = {
      updateIfStateDataUnchanged: vi.fn(async () => primaryAccepts),
    };
    const secondary = {
      updateIfStateDataUnchanged: vi.fn(async () => true),
    };
    const adapter = createPassthroughAdapter({
      primary,
      secondaries: [{ adapter: secondary, blocking: true }],
    });
    return { adapter, secondary };
  }

  it("mirrors a write the primary accepted", async () => {
    const { adapter, secondary } = setup(true);

    expect(
      await adapter.updateIfStateDataUnchanged("tenantId", "login", "{}", {
        state_data: '{"n":1}',
      }),
    ).toBe(true);
    expect(secondary.updateIfStateDataUnchanged).toHaveBeenCalledWith(
      "tenantId",
      "login",
      "{}",
      { state_data: '{"n":1}' },
    );
  });

  it("does not mirror a write the primary rejected", async () => {
    const { adapter, secondary } = setup(false);

    expect(
      await adapter.updateIfStateDataUnchanged("tenantId", "login", "{}", {
        state_data: '{"n":1}',
      }),
    ).toBe(false);
    expect(secondary.updateIfStateDataUnchanged).not.toHaveBeenCalled();
  });
});
