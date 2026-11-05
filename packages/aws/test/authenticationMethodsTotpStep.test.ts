import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  clearTestData,
  getTestServer,
  teardownTestServer,
} from "./helpers/test-server";

async function setup() {
  const { data } = await getTestServer();
  await data.tenants.create({
    id: "tenantId",
    friendly_name: "Test Tenant",
    audience: "https://example.com",
    sender_email: "login@example.com",
    sender_name: "SenderName",
  });
  const method = await data.authenticationMethods.create("tenantId", {
    user_id: "email|userId",
    type: "totp",
    totp_secret: "JBSWY3DPEHPK3PXP",
    confirmed: true,
  });
  return { data, method };
}

describe("authenticationMethods.consumeTotpStep", () => {
  afterEach(async () => {
    await clearTestData();
  });

  afterAll(async () => {
    await teardownTestServer();
  });

  it("accepts a step once and rejects the same or an earlier step", async () => {
    const { data, method } = await setup();
    const methods = data.authenticationMethods;

    expect(method.totp_last_step).toBeUndefined();
    expect(await methods.consumeTotpStep("tenantId", method.id, 1000)).toBe(
      true,
    );
    expect((await methods.get("tenantId", method.id))?.totp_last_step).toBe(
      1000,
    );

    expect(await methods.consumeTotpStep("tenantId", method.id, 1000)).toBe(
      false,
    );
    expect(await methods.consumeTotpStep("tenantId", method.id, 999)).toBe(
      false,
    );
    expect(await methods.consumeTotpStep("tenantId", method.id, 1001)).toBe(
      true,
    );
    expect((await methods.get("tenantId", method.id))?.totp_last_step).toBe(
      1001,
    );
  });

  it("lets exactly one of two concurrent submits of the same step win", async () => {
    const { data, method } = await setup();
    const results = await Promise.all([
      data.authenticationMethods.consumeTotpStep("tenantId", method.id, 2000),
      data.authenticationMethods.consumeTotpStep("tenantId", method.id, 2000),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("returns false for an unknown method or another tenant", async () => {
    const { data, method } = await setup();
    expect(
      await data.authenticationMethods.consumeTotpStep(
        "tenantId",
        "missing",
        1,
      ),
    ).toBe(false);
    expect(
      await data.authenticationMethods.consumeTotpStep(
        "otherTenant",
        method.id,
        1,
      ),
    ).toBe(false);
  });

  it("stores a step given on create", async () => {
    const { data } = await setup();
    const created = await data.authenticationMethods.create("tenantId", {
      user_id: "email|userId",
      type: "totp",
      totp_secret: "JBSWY3DPEHPK3PXP",
      totp_last_step: 500,
      confirmed: true,
    });
    expect(
      (await data.authenticationMethods.get("tenantId", created.id))
        ?.totp_last_step,
    ).toBe(500);
    expect(
      await data.authenticationMethods.consumeTotpStep(
        "tenantId",
        created.id,
        500,
      ),
    ).toBe(false);
  });
});
