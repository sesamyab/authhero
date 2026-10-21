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

  it("rejects re-parenting that pushes a descendant past the max depth", async () => {
    const parents: Record<string, string | null> = {
      R: null,
      C: "R",
      A: null,
      B: "A",
    };
    const getChildren = async (id: string) =>
      Object.keys(parents).filter((k) => parents[k] === id);

    // A moves under C -> R (2 ancestors); B below A would get 3.
    await expect(
      validateTenantParent({
        tenantId: "A",
        parentTenantId: "C",
        getTenant: tree(parents),
        getChildren,
      }),
    ).rejects.toMatchObject({ status: 400 });

    // Allowed when the new parent is a root: B ends up with 2 ancestors.
    await expect(
      validateTenantParent({
        tenantId: "A",
        parentTenantId: "R",
        getTenant: tree(parents),
        getChildren,
      }),
    ).resolves.toBeUndefined();
  });
});
