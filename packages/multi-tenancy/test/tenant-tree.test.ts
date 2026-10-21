import { describe, expect, it } from "vitest";
import { validateTenantParent } from "../src/utils/tenant-tree";

function tree(parents: Record<string, string | null>) {
  return async (id: string) =>
    id in parents ? { id, parent_tenant_id: parents[id] } : null;
}

describe("validateTenantParent", () => {
  it("accepts a tenant without a parent", async () => {
    await expect(
      validateTenantParent({
        tenantId: "a",
        parentTenantId: undefined,
        getTenant: tree({}),
      }),
    ).resolves.toBeUndefined();
  });

  it("accepts a chain up to the max depth", async () => {
    await expect(
      validateTenantParent({
        tenantId: "child",
        parentTenantId: "mid",
        getTenant: tree({ mid: "root", root: null }),
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a chain deeper than the max depth", async () => {
    await expect(
      validateTenantParent({
        tenantId: "child",
        parentTenantId: "c",
        getTenant: tree({ c: "b", b: "a", a: null }),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("honours a custom max depth", async () => {
    await expect(
      validateTenantParent({
        tenantId: "child",
        parentTenantId: "c",
        getTenant: tree({ c: "b", b: "a", a: null }),
        maxDepth: 3,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects a missing parent", async () => {
    await expect(
      validateTenantParent({
        tenantId: "child",
        parentTenantId: "nope",
        getTenant: tree({}),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects self-parenting and cycles", async () => {
    await expect(
      validateTenantParent({
        tenantId: "a",
        parentTenantId: "a",
        getTenant: tree({ a: null }),
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      validateTenantParent({
        tenantId: "a",
        parentTenantId: "b",
        getTenant: tree({ a: "b", b: "a" }),
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
