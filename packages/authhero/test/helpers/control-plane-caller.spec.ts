import { describe, expect, it } from "vitest";
import { callerIsControlPlane } from "../../src/helpers/control-plane-caller";

// `null` means the deployment has no control plane configured.
const ctx = (
  user: Record<string, unknown> | undefined,
  controlPlaneTenantId: string | null = "control_plane",
  vars: Record<string, unknown> = {},
) => ({
  env: {
    data: {
      multiTenancyConfig:
        controlPlaneTenantId === null ? undefined : { controlPlaneTenantId },
    },
  },
  var: { user, ...vars },
});

describe("callerIsControlPlane", () => {
  it("accepts a token from the control plane", () => {
    expect(callerIsControlPlane(ctx({ tenant_id: "control_plane" }))).toBe(
      true,
    );
  });

  it("rejects a token from another tenant", () => {
    expect(callerIsControlPlane(ctx({ tenant_id: "acme" }))).toBe(false);
  });

  it("rejects a token without a tenant claim", () => {
    expect(callerIsControlPlane(ctx({}))).toBe(false);
  });

  it("rejects a request without a user", () => {
    expect(callerIsControlPlane(ctx(undefined))).toBe(false);
  });

  it("rejects organization-scoped tokens, even from the control plane", () => {
    expect(
      callerIsControlPlane(
        ctx({ tenant_id: "control_plane", org_id: "org_1" }),
      ),
    ).toBe(false);
    expect(
      callerIsControlPlane(
        ctx({ tenant_id: "control_plane" }, "control_plane", {
          org_name: "acme",
        }),
      ),
    ).toBe(false);
  });

  it("treats a deployment without a control plane as one", () => {
    expect(callerIsControlPlane(ctx({ tenant_id: "acme" }, null))).toBe(true);
  });
});
