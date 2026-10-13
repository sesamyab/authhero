import { describe, expect, it } from "vitest";
import { getTestServer } from "../helpers/test-server";

async function setup() {
  const { data } = getTestServer();
  await data.tenants.create({
    id: "tenantId",
    friendly_name: "Test Tenant",
    audience: "https://example.com",
    sender_email: "login@example.com",
    sender_name: "SenderName",
  });
  return data;
}

describe("drizzle promptPartials", () => {
  it("sets, replaces, lists, and deletes tenant-scoped partials", async () => {
    const data = await setup();

    expect(await data.promptPartials.get("tenantId", "signup")).toBeNull();

    await data.promptPartials.set("tenantId", "signup", {
      signup: {
        "form-content-start": "<p>First</p>",
        "form-content-end": "<p>Removed on replace</p>",
      },
    });
    await data.promptPartials.set("tenantId", "signup", {
      signup: { "form-footer-end": "<p>Replacement</p>" },
    });

    expect(await data.promptPartials.get("tenantId", "signup")).toEqual({
      signup: { "form-footer-end": "<p>Replacement</p>" },
    });
    expect(await data.promptPartials.list("tenantId")).toEqual(["signup"]);

    await data.promptPartials.delete("tenantId", "signup");
    expect(await data.promptPartials.get("tenantId", "signup")).toBeNull();
  });
});
