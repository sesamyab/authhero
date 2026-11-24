import { describe, it, expect, beforeEach } from "vitest";
import { getTestServer } from "./helpers/test-server";

const TENANT = "tenant1";
const OTHER = "tenant2";

describe("clientRegistrationTokens storage (#1776)", () => {
  let data: Awaited<ReturnType<typeof getTestServer>>["data"];

  beforeEach(async () => {
    const server = await getTestServer();
    data = server.data;
    for (const id of [TENANT, OTHER]) {
      await data.tenants.create({
        id,
        friendly_name: id,
        audience: "https://example.com",
        sender_email: "login@example.com",
        sender_name: "SenderName",
      });
    }
  });

  async function seed(
    adapter: NonNullable<typeof data.clientRegistrationTokens>,
  ) {
    const base = Date.now();
    const invite = await adapter.create(TENANT, {
      id: "invite1",
      token_hash: "hash-invite1",
      type: "iat",
      single_use: true,
      expires_at: new Date(base + 7 * 86400_000).toISOString(),
      constraints: { app_type: "native" },
      name: "Agency iOS app",
      created_by: "auth0|admin",
      source: "invite",
    });
    // created_at comes from the clock; space the rows out so ordering is stable.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await adapter.create(TENANT, {
      id: "rat1",
      token_hash: "hash-rat1",
      type: "rat",
      client_id: "client1",
      single_use: false,
      source: "registration",
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await adapter.create(TENANT, {
      id: "edit1",
      token_hash: "hash-edit1",
      type: "rat",
      client_id: "client1",
      single_use: false,
      source: "edit_link",
      name: "Edit link",
    });
    await adapter.create(OTHER, {
      id: "other1",
      token_hash: "hash-other1",
      type: "iat",
      single_use: true,
      source: "invite",
    });
    return invite;
  }

  it("stores name, created_by and source", async () => {
    const adapter = data.clientRegistrationTokens!;
    const invite = await seed(adapter);
    expect(invite).toMatchObject({
      name: "Agency iOS app",
      created_by: "auth0|admin",
      source: "invite",
    });
    expect(await adapter.get(TENANT, "invite1")).toMatchObject({
      name: "Agency iOS app",
      created_by: "auth0|admin",
      source: "invite",
      constraints: { app_type: "native" },
    });
  });

  it("lists a tenant's tokens newest first, with filters and totals", async () => {
    const adapter = data.clientRegistrationTokens!;
    await seed(adapter);

    const all = await adapter.list(TENANT, { include_totals: true });
    expect(all.client_registration_tokens.map((t) => t.id)).toEqual([
      "edit1",
      "rat1",
      "invite1",
    ]);
    expect(all.total).toBe(3);

    expect(
      (
        await adapter.list(TENANT, { type: "iat" })
      ).client_registration_tokens.map((t) => t.id),
    ).toEqual(["invite1"]);
    expect(
      (
        await adapter.list(TENANT, { source: "edit_link" })
      ).client_registration_tokens.map((t) => t.id),
    ).toEqual(["edit1"]);
    expect(
      (
        await adapter.list(TENANT, { client_id: "client1" })
      ).client_registration_tokens.map((t) => t.id),
    ).toEqual(["edit1", "rat1"]);

    const page = await adapter.list(TENANT, {
      page: 1,
      per_page: 2,
      include_totals: true,
    });
    expect(page.client_registration_tokens.map((t) => t.id)).toEqual([
      "invite1",
    ]);
    expect(page).toMatchObject({ start: 2, limit: 2, length: 1, total: 3 });

    expect(
      (await adapter.list(OTHER)).client_registration_tokens.map((t) => t.id),
    ).toEqual(["other1"]);
  });

  it("markUsed records the created client once", async () => {
    const adapter = data.clientRegistrationTokens!;
    await seed(adapter);
    const usedAt = new Date().toISOString();

    expect(await adapter.markUsed(TENANT, "invite1", usedAt, "client2")).toBe(
      true,
    );
    expect(await adapter.markUsed(TENANT, "invite1", usedAt, "client3")).toBe(
      false,
    );
    const used = await adapter.get(TENANT, "invite1");
    expect(used?.client_id).toBe("client2");
    expect(used?.used_at).toBeTruthy();
    expect(
      (await adapter.listByClient(TENANT, "client2")).map((t) => t.id),
    ).toEqual(["invite1"]);
  });
});
