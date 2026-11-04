import { describe, expect, it } from "vitest";
import { tenantInsertSchema, tenantPatchSchema } from "../src/types/Tenant";

describe("tenantPatchSchema", () => {
  it("keeps only the keys that are present in the body", () => {
    expect(tenantPatchSchema.parse({ config_sync: "synced" })).toEqual({
      config_sync: "synced",
    });
  });

  it("does not fill in the create-time defaults that insert applies", () => {
    // The reason the patch schema exists: zod 4 keeps `.default()` through
    // `.partial()`, so the insert shape would add these on every patch.
    expect(tenantInsertSchema.partial().parse({})).toMatchObject({
      deployment_type: "shared",
      provisioning_state: "ready",
    });
    expect(tenantPatchSchema.parse({})).toEqual({});
  });

  it("does not fill in the MFA defaults for the fields a patch omits", () => {
    // What a patch body would be turned into by the insert shape: the policy
    // switched off and every factor other than `sms` off.
    expect(
      tenantInsertSchema.partial().parse({ mfa: { factors: { sms: true } } }),
    ).toMatchObject({
      mfa: { policy: "never", factors: { sms: true, otp: false, duo: false } },
    });
    expect(
      tenantPatchSchema.parse({ mfa: { factors: { sms: true } } }),
    ).toEqual({ mfa: { factors: { sms: true } } });
    expect(tenantPatchSchema.parse({ mfa: { policy: "always" } })).toEqual({
      mfa: { policy: "always" },
    });
  });

  it("accepts every field the insert schema accepts for mfa", () => {
    const body = {
      mfa: {
        policy: "always" as const,
        factors: {
          sms: true,
          otp: false,
          email: true,
          push_notification: false,
          webauthn_roaming: true,
          webauthn_platform: false,
          recovery_code: true,
          duo: false,
        },
        sms_provider: { provider: "twilio" as const },
        twilio: {
          sid: "AC1",
          auth_token: "t",
          from: "+1",
          messaging_service_sid: "MG1",
        },
        phone_message: { message: "code {{code}}" },
      },
    };
    expect(tenantPatchSchema.parse(body)).toEqual(body);
    expect(
      tenantInsertSchema.parse({ ...body, friendly_name: "n" }).mfa,
    ).toEqual(body.mfa);
  });

  it("lists the same MFA factors as the insert schema", () => {
    // The patch schema repeats the factor list without defaults: this fails if
    // a factor is added to one and not the other.
    const insertFactors = Object.keys(
      tenantInsertSchema.shape.mfa.unwrap().shape.factors.unwrap().shape,
    ).sort();
    const allOn = Object.fromEntries(insertFactors.map((k) => [k, true]));

    expect(tenantPatchSchema.parse({ mfa: { factors: allOn } })).toEqual({
      mfa: { factors: allOn },
    });
    // A factor the patch schema does not know would be dropped, not kept.
    expect(
      Object.keys(
        tenantPatchSchema.parse({ mfa: { factors: allOn } }).mfa?.factors ?? {},
      ).sort(),
    ).toEqual(insertFactors);
  });
});
