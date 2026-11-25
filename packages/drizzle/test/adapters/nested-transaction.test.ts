import { describe, it, expect, beforeEach } from "vitest";
import { getTestServer } from "../helpers/test-server";

// Real better-sqlite3: multi-statement writes (runAtomic) and nested
// transaction() calls must work inside an open transaction(). SQLite can't
// start a transaction within a transaction, so they have to join the outer one.

function userWithPassword(id: string) {
  return {
    user_id: `auth2|${id}`,
    email: `${id}@example.com`,
    email_verified: false,
    connection: "Username-Password-Authentication",
    provider: "auth2",
    is_social: false,
    password: { hash: "hash", algorithm: "bcrypt" },
  };
}

describe("writes inside transaction() on better-sqlite3", () => {
  let data: ReturnType<typeof getTestServer>["data"];

  beforeEach(async () => {
    data = getTestServer().data;
    await data.tenants.create({ id: "tenant1", name: "Test Tenant" } as any);
  });

  it("creates a user with a password inside transaction()", async () => {
    const created = await data.transaction((trx) =>
      trx.users.create("tenant1", userWithPassword("inside") as any),
    );

    expect(created.user_id).toBe("auth2|inside");
    expect(await data.users.get("tenant1", "auth2|inside")).toBeTruthy();
    expect(await data.passwords.get("tenant1", "auth2|inside")).toBeTruthy();
  });

  it("rolls the user and password back with the outer transaction", async () => {
    await expect(
      data.transaction(async (trx) => {
        await trx.users.create("tenant1", userWithPassword("rollback") as any);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await data.users.get("tenant1", "auth2|rollback")).toBeNull();
    expect(await data.passwords.get("tenant1", "auth2|rollback")).toBeNull();
  });

  it("joins a nested transaction() to the outer one", async () => {
    await data.transaction((outer) =>
      outer.transaction((inner) =>
        inner.users.create("tenant1", userWithPassword("nested") as any),
      ),
    );
    expect(await data.users.get("tenant1", "auth2|nested")).toBeTruthy();

    await expect(
      data.transaction(async (outer) => {
        await outer.transaction((inner) =>
          inner.users.create(
            "tenant1",
            userWithPassword("nested-rollback") as any,
          ),
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await data.users.get("tenant1", "auth2|nested-rollback")).toBeNull();
  });

  it("still creates a user with a password outside a transaction", async () => {
    await data.users.create("tenant1", userWithPassword("outside") as any);
    expect(await data.passwords.get("tenant1", "auth2|outside")).toBeTruthy();
  });
});
