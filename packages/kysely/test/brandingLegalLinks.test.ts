import { describe, it, expect } from "vitest";
import { getTestServer } from "./helpers/test-server";

async function setup() {
  const { data } = await getTestServer();
  await data.tenants.create({
    id: "tenantId",
    friendly_name: "Test Tenant",
    audience: "https://example.com",
    sender_email: "login@example.com",
    sender_name: "SenderName",
  });
  return data;
}

describe("branding legal links (kysely)", () => {
  it("round-trips terms_url and privacy_url", async () => {
    const data = await setup();
    await data.branding.set("tenantId", {
      terms_url: "https://example.com/terms",
      privacy_url: "https://example.com/privacy",
    });

    const branding = await data.branding.get("tenantId");
    expect(branding?.terms_url).toBe("https://example.com/terms");
    expect(branding?.privacy_url).toBe("https://example.com/privacy");
  });

  it("reads back without them when never set", async () => {
    const data = await setup();
    await data.branding.set("tenantId", { logo_url: "https://e.com/l.png" });

    const branding = await data.branding.get("tenantId");
    expect(branding?.terms_url).toBeUndefined();
    expect(branding?.privacy_url).toBeUndefined();
  });
});
