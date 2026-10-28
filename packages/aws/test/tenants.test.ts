import { describe, expect, it, afterEach } from "vitest";
import { getTestServer, teardownTestServer } from "./helpers/test-server";

describe("tenants", () => {
  afterEach(async () => {
    await teardownTestServer();
  });

  it("should support crud operations", async () => {
    const { data } = await getTestServer();

    // ----------------------------------------
    // Create
    // ----------------------------------------
    const created = await data.tenants.create({
      id: "test-tenant",
      friendly_name: "Test Tenant",
      audience: "https://api.example.com",
      sender_email: "noreply@example.com",
      sender_name: "Test",
    });

    expect(created.id).toBe("test-tenant");
    expect(created.friendly_name).toBe("Test Tenant");
    expect(created.created_at).toBeDefined();
    expect(created.updated_at).toBeDefined();

    // ----------------------------------------
    // Get
    // ----------------------------------------
    const fetched = await data.tenants.get("test-tenant");
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe("test-tenant");
    expect(fetched?.friendly_name).toBe("Test Tenant");

    // ----------------------------------------
    // Update
    // ----------------------------------------
    await data.tenants.update("test-tenant", {
      friendly_name: "Updated Tenant Name",
    });

    // Verify update
    const fetchedAfterUpdate = await data.tenants.get("test-tenant");
    expect(fetchedAfterUpdate?.friendly_name).toBe("Updated Tenant Name");

    // ----------------------------------------
    // List
    // ----------------------------------------
    const list = await data.tenants.list();
    expect(list.tenants.length).toBeGreaterThanOrEqual(1);
    expect(list.tenants.some((t) => t.id === "test-tenant")).toBe(true);

    // ----------------------------------------
    // Delete
    // ----------------------------------------
    const deleted = await data.tenants.remove("test-tenant");
    expect(deleted).toBe(true);

    // Verify deletion
    const fetchedAfterDelete = await data.tenants.get("test-tenant");
    expect(fetchedAfterDelete).toBeNull();
  });

  it("should match q against id and friendly_name", async () => {
    const { data } = await getTestServer();
    const base = {
      audience: "https://api.example.com",
      sender_email: "noreply@example.com",
      sender_name: "Test",
    };
    await data.tenants.create({
      ...base,
      id: "acme-prod",
      friendly_name: "Acme",
    });
    await data.tenants.create({ ...base, id: "other", friendly_name: "Other" });

    for (const q of ["acme-prod", "prod", "Acme"]) {
      const res = await data.tenants.list({ q });
      expect(res.tenants.map((t) => t.id)).toEqual(["acme-prod"]);
    }
  });

  it("should return null for non-existent tenant", async () => {
    const { data } = await getTestServer();

    const result = await data.tenants.get("non-existent-tenant");
    expect(result).toBeNull();
  });

  it("should handle multiple tenants", async () => {
    const { data } = await getTestServer();

    await data.tenants.create({
      id: "tenant-1",
      friendly_name: "Tenant 1",
      audience: "https://api1.example.com",
      sender_email: "noreply@tenant1.com",
      sender_name: "Tenant 1",
    });

    await data.tenants.create({
      id: "tenant-2",
      friendly_name: "Tenant 2",
      audience: "https://api2.example.com",
      sender_email: "noreply@tenant2.com",
      sender_name: "Tenant 2",
    });

    const list = await data.tenants.list();
    expect(list.tenants.length).toBe(2);
  });
  it("lists the children of a tenant for a parent_tenant_id query", async () => {
    const { data } = await getTestServer();
    const create = (id: string, parent?: string) =>
      data.tenants.create({
        id,
        friendly_name: id,
        audience: "https://example.com",
        sender_email: "login@example.com",
        sender_name: id,
        ...(parent ? { parent_tenant_id: parent } : {}),
      });
    await create("partner");
    await create("leaf", "partner");
    await create("other");
    await create("spaced parent");
    await create("spaced leaf", "spaced parent");

    const children = async (q: string) =>
      (await data.tenants.list({ q, include_totals: true })).tenants.map(
        (t) => t.id,
      );

    expect(await children("parent_tenant_id:partner")).toEqual(["leaf"]);
    expect(await children('parent_tenant_id:"spaced parent"')).toEqual([
      "spaced leaf",
    ]);
    expect(await children("parent_tenant_id:other")).toEqual([]);
    // Free-text search still matches the id and the name.
    expect(await children("partner")).toContain("partner");
  });
});
