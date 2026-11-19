import { describe, it, expect } from "vitest";
import { getTestServer } from "./helpers/test-server";

describe("tenants list q", () => {
  it("matches q against id and friendly_name", async () => {
    const { data } = await getTestServer();
    await data.tenants.create({ id: "acme-prod", friendly_name: "Acme" });
    await data.tenants.create({ id: "other", friendly_name: "Other" });

    for (const q of ["acme-prod", "prod", "Acme"]) {
      const res = await data.tenants.list({ q });
      expect(res.tenants.map((t) => t.id)).toEqual(["acme-prod"]);
    }
  });
});

describe("tenants update", () => {
  it("clears sender_email with an explicit null", async () => {
    const { data } = await getTestServer();
    await data.tenants.create({
      id: "acme",
      friendly_name: "Acme",
      sender_email: "no-reply@example.com",
    });

    await data.tenants.update("acme", { sender_email: null });

    const tenant = await data.tenants.get("acme");
    expect(tenant?.sender_email ?? null).toBeNull();
  });
});
