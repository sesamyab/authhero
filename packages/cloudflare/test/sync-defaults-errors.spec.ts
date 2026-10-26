import { describe, expect, it } from "vitest";
import { collectSyncDefaultsErrors } from "../src/wfp-provisioner/sync-defaults-errors";

describe("collectSyncDefaultsErrors", () => {
  it("collects per-entity errors from the defaults result", () => {
    expect(
      collectSyncDefaultsErrors({
        connections: { received: 1, upserted: 0, errors: ["connection: boom"] },
        hooks: { received: 0, upserted: 0, errors: [] },
        tenantId: "cp",
      }),
    ).toEqual(["connection: boom"]);
  });

  it("also collects errors nested in a resolved config block", () => {
    expect(
      collectSyncDefaultsErrors({
        connections: { errors: ["a"] },
        resolved: {
          status: "applied",
          entities: {
            action: { added: 0, errors: ["action x: bad"] },
            hook: { added: 0, errors: [] },
          },
        },
      }),
    ).toEqual(["a", "action x: bad"]);
  });

  it("ignores values that are not results", () => {
    expect(collectSyncDefaultsErrors(null)).toEqual([]);
    expect(collectSyncDefaultsErrors("nope")).toEqual([]);
    expect(collectSyncDefaultsErrors({ resolved: { entities: null } })).toEqual(
      [],
    );
  });
});
