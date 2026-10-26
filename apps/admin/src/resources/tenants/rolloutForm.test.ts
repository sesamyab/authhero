import { describe, expect, it } from "vitest";
import { DEFAULT_ROLLOUT_FORM, toCreateRolloutInput } from "./rolloutForm";

describe("toCreateRolloutInput", () => {
  it("turns the defaults into a request", () => {
    expect(toCreateRolloutInput(DEFAULT_ROLLOUT_FORM)).toEqual({
      input: { canary: 1, waves: [10, 50, 100], failure_threshold: 0.1 },
    });
  });

  it("passes the root tenant, dry run and force", () => {
    expect(
      toCreateRolloutInput({
        ...DEFAULT_ROLLOUT_FORM,
        rootTenantId: " partner ",
        dryRun: true,
        force: true,
      }),
    ).toEqual({
      input: {
        root_tenant_id: "partner",
        canary: 1,
        waves: [10, 50, 100],
        failure_threshold: 0.1,
        dry_run: true,
        force: true,
      },
    });
  });

  it.each([
    [{ canary: "-1" }, /Canary/],
    [{ canary: "1.5" }, /Canary/],
    [{ waves: "50, 10" }, /Waves/],
    [{ waves: "10, 150" }, /Waves/],
    [{ waves: "" }, /Waves/],
    [{ failureThreshold: "120" }, /threshold/],
  ])("rejects %j", (patch, message) => {
    const result = toCreateRolloutInput({ ...DEFAULT_ROLLOUT_FORM, ...patch });
    expect(result).toEqual({ error: expect.stringMatching(message) });
  });
});
