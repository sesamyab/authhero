import { describe, it, expect, beforeEach } from "vitest";
import { getTestServer } from "../helpers/test-server";

// Members of DataAdapters that are runtime/binding based and injected by the
// host application rather than backed by the drizzle schema.
const HOST_PROVIDED = [
  "cache",
  "geo",
  "rateLimit",
  "emailService",
  "smsService",
];

describe("drizzle DataAdapters contract (#1516)", () => {
  it("wires the DB-backed adapters", () => {
    const { data } = getTestServer();
    for (const key of [
      "organizationConnections",
      "logStreams",
      "migrationSources",
    ]) {
      expect((data as any)[key], key).toBeDefined();
    }
    for (const key of HOST_PROVIDED) {
      expect((data as any)[key], key).toBeUndefined();
    }
  });
});

describe("organizationConnections, logStreams, migrationSources", () => {
  let data: ReturnType<typeof getTestServer>["data"];

  beforeEach(async () => {
    data = getTestServer().data;
    await data.tenants.create({ id: "tenant1", name: "Test Tenant" });
  });

  it("organizationConnections CRUD", async () => {
    const created = await data.organizationConnections.create(
      "tenant1",
      "org1",
      { connection_id: "con1", assign_membership_on_login: true },
    );
    expect(created.assign_membership_on_login).toBe(true);
    expect(created.show_as_button).toBe(true);

    expect(
      await data.organizationConnections.list("tenant1", "org1"),
    ).toHaveLength(1);

    const updated = await data.organizationConnections.update(
      "tenant1",
      "org1",
      "con1",
      { show_as_button: false },
    );
    expect(updated?.show_as_button).toBe(false);
    expect(
      await data.organizationConnections.update("tenant1", "org1", "nope", {}),
    ).toBeNull();

    expect(
      await data.organizationConnections.remove("tenant1", "org1", "con1"),
    ).toBe(true);
    expect(
      await data.organizationConnections.get("tenant1", "org1", "con1"),
    ).toBeNull();
    expect(
      await data.organizationConnections.remove("tenant1", "org1", "con1"),
    ).toBe(false);
  });

  it("logStreams CRUD", async () => {
    const created = await data.logStreams!.create("tenant1", {
      name: "stream",
      type: "http",
      sink: { httpEndpoint: "https://example.com" },
    } as any);
    expect(created.id).toMatch(/^lst_/);
    expect(created.status).toBe("active");

    expect(
      await data.logStreams!.update("tenant1", created.id, {
        isPriority: true,
      }),
    ).toBe(true);
    expect(
      (await data.logStreams!.get("tenant1", created.id))?.isPriority,
    ).toBe(true);
    expect(await data.logStreams!.list("tenant1")).toHaveLength(1);
    expect(await data.logStreams!.remove("tenant1", created.id)).toBe(true);
    expect(await data.logStreams!.get("tenant1", created.id)).toBeNull();
  });

  it("migrationSources CRUD", async () => {
    const created = await data.migrationSources!.create("tenant1", {
      name: "src",
      provider: "auth0",
      connection: "Username-Password-Authentication",
      credentials: {
        domain: "x.auth0.com",
        client_id: "a",
        client_secret: "b",
      },
    } as any);
    expect(created.enabled).toBe(true);

    expect(
      await data.migrationSources!.update("tenant1", created.id, {
        enabled: false,
      }),
    ).toBe(true);
    expect(
      (await data.migrationSources!.get("tenant1", created.id))?.enabled,
    ).toBe(false);
    expect(await data.migrationSources!.list("tenant1")).toHaveLength(1);
    expect(await data.migrationSources!.remove("tenant1", created.id)).toBe(
      true,
    );
    expect(await data.migrationSources!.update("tenant1", created.id, {})).toBe(
      false,
    );
  });
});
