import { describe, expect, it, vi } from "vitest";
import { createPassthroughAdapter } from "../src/utils/passthrough";

type Fields = { state_data: string };

/** In-memory login session store with a real compare-and-swap. */
function store() {
  let stateData = "";
  return {
    current: () => stateData,
    updateIfStateDataUnchanged: async (
      _tenant: string,
      _id: string,
      expected: string | undefined,
      fields: Fields,
    ) => {
      if ((stateData || undefined) !== expected) return false;
      stateData = fields.state_data;
      return true;
    },
    update: async (_tenant: string, _id: string, fields: Fields) => {
      stateData = fields.state_data;
      return true;
    },
  };
}

describe("createPassthroughAdapter updateIfStateDataUnchanged", () => {
  it("mirrors a write the primary accepted as an unconditional update", async () => {
    const primary = store();
    const secondary = {
      update: vi.fn(async () => true),
      updateIfStateDataUnchanged: vi.fn(async () => true),
    };
    const adapter = createPassthroughAdapter({
      primary,
      secondaries: [{ adapter: secondary, blocking: true }],
    });

    expect(
      await adapter.updateIfStateDataUnchanged("tenantId", "login", undefined, {
        state_data: "1",
      }),
    ).toBe(true);
    expect(secondary.update).toHaveBeenCalledWith("tenantId", "login", {
      state_data: "1",
    });
    expect(secondary.updateIfStateDataUnchanged).not.toHaveBeenCalled();
  });

  it("does not mirror a write the primary rejected", async () => {
    const primary = store();
    const secondary = { update: vi.fn(async () => true) };
    const adapter = createPassthroughAdapter({
      primary,
      secondaries: [{ adapter: secondary, blocking: true }],
    });

    expect(
      await adapter.updateIfStateDataUnchanged("tenantId", "login", "stale", {
        state_data: "1",
      }),
    ).toBe(false);
    expect(secondary.update).not.toHaveBeenCalled();
  });

  it("recovers from mirrors that arrive out of order", async () => {
    const primary = store();
    const secondaryStore = store();
    // Hold each mirror until released, to deliver them in reverse order.
    const pending: Array<() => Promise<void>> = [];
    const secondary = {
      update: (tenant: string, id: string, fields: Fields) =>
        new Promise<boolean>((resolve) => {
          pending.push(async () =>
            resolve(await secondaryStore.update(tenant, id, fields)),
          );
        }),
    };
    const adapter = createPassthroughAdapter({
      primary,
      secondaries: [{ adapter: secondary }],
    });

    await adapter.updateIfStateDataUnchanged("t", "login", undefined, {
      state_data: "1",
    });
    await adapter.updateIfStateDataUnchanged("t", "login", "1", {
      state_data: "2",
    });
    // "1" lands after "2": the secondary is briefly behind the primary.
    await pending[1]!();
    await pending[0]!();
    expect(secondaryStore.current()).toBe("1");

    // The next accepted write is not rejected by the stale secondary.
    await adapter.updateIfStateDataUnchanged("t", "login", "2", {
      state_data: "3",
    });
    await pending[2]!();
    expect(primary.current()).toBe("3");
    expect(secondaryStore.current()).toBe("3");
  });
});
