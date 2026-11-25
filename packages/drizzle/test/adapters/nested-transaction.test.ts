import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getTestServer } from "../helpers/test-server";
import { transactionLockSettings } from "../../src/adapters/atomic";

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

describe("concurrent callers on one better-sqlite3 connection", () => {
  let data: ReturnType<typeof getTestServer>["data"];

  beforeEach(async () => {
    data = getTestServer().data;
    await data.tenants.create({ id: "tenant1", name: "Test Tenant" } as any);
  });

  afterEach(() => {
    transactionLockSettings.timeoutMs = 10_000;
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

  function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { open, opened };
  }

  it("does not let another caller's transaction() join and lose its rows", async () => {
    const aStarted = gate();
    const aMayFinish = gate();
    const order: string[] = [];

    // A opens a transaction, waits, then fails and rolls back.
    const a = data.transaction(async (trx) => {
      await trx.users.create("tenant1", userWithPassword("a") as any);
      aStarted.open();
      await aMayFinish.opened;
      order.push("a-rollback");
      throw new Error("a failed");
    });
    await aStarted.opened;

    // B is an unrelated signup that starts while A's transaction is open.
    const b = data
      .transaction((trx) =>
        trx.users.create("tenant1", userWithPassword("b") as any),
      )
      .then(() => order.push("b-committed"));

    // Give B time to reach its write while A's transaction is still open.
    await settle();
    aMayFinish.open();
    await expect(a).rejects.toThrow("a failed");
    await b;

    // B waited for A instead of writing into A's transaction.
    expect(order).toEqual(["a-rollback", "b-committed"]);
    expect(await data.users.get("tenant1", "auth2|a")).toBeNull();
    expect(await data.users.get("tenant1", "auth2|b")).toBeTruthy();
    expect(await data.passwords.get("tenant1", "auth2|b")).toBeTruthy();
  });

  it("makes a multi-statement write outside any transaction wait too", async () => {
    const aStarted = gate();
    const aMayFinish = gate();

    const a = data.transaction(async (trx) => {
      await trx.users.create("tenant1", userWithPassword("a2") as any);
      aStarted.open();
      await aMayFinish.opened;
      throw new Error("a failed");
    });
    await aStarted.opened;

    // users.create with a password goes through runAtomic.
    const b = data.users.create("tenant1", userWithPassword("b2") as any);

    // Give B time to reach its write while A's transaction is still open.
    await settle();
    aMayFinish.open();
    await expect(a).rejects.toThrow("a failed");
    await b;

    expect(await data.users.get("tenant1", "auth2|a2")).toBeNull();
    expect(await data.passwords.get("tenant1", "auth2|b2")).toBeTruthy();
  });

  it("fails clearly instead of hanging when a callback writes through outer adapters", async () => {
    transactionLockSettings.timeoutMs = 50;

    await expect(
      data.transaction(async () => {
        // Wrong: the outer adapters instead of the callback's own. This can
        // never get the connection while the transaction holds it.
        await data.users.create("tenant1", userWithPassword("outer") as any);
      }),
    ).rejects.toThrow();
    expect(await data.users.get("tenant1", "auth2|outer")).toBeNull();

    // The connection is usable again afterwards.
    await data.users.create("tenant1", userWithPassword("after") as any);
    expect(await data.users.get("tenant1", "auth2|after")).toBeTruthy();
  });
});
