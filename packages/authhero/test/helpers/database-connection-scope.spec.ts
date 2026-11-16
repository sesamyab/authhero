import { describe, it, expect } from "vitest";
import {
  DatabaseConnectionScope,
  isUserInConnectionScope,
  resolveClientDatabaseConnectionName,
  resolveDatabaseConnectionScope,
} from "../../src/helpers/database-connection-scope";
import { getTestServer } from "./test-server";

const scope: DatabaseConnectionScope = {
  name: "Username-Password-Authentication",
  databaseConnectionNames: new Set([
    "Username-Password-Authentication",
    "cte-store",
  ]),
};

describe("isUserInConnectionScope", () => {
  it("matches every row without a scope", () => {
    expect(
      isUserInConnectionScope({ connection: "cte-store" }, undefined),
    ).toBe(true);
  });

  it("matches rows of the scoped connection", () => {
    expect(
      isUserInConnectionScope(
        { connection: "Username-Password-Authentication" },
        scope,
      ),
    ).toBe(true);
  });

  it("skips rows of another database connection", () => {
    expect(isUserInConnectionScope({ connection: "cte-store" }, scope)).toBe(
      false,
    );
  });

  it("keeps rows whose connection names no database connection", () => {
    expect(isUserInConnectionScope({ connection: "auth2" }, scope)).toBe(true);
    expect(isUserInConnectionScope({ connection: "" }, scope)).toBe(true);
    expect(isUserInConnectionScope({}, scope)).toBe(true);
  });
});

describe("resolveClientDatabaseConnectionName", () => {
  const db = (name: string) => ({ name, strategy: "auth0" });
  const email = { name: "email", strategy: "email" };

  it("uses an explicit non-generic realm as is", () => {
    expect(
      resolveClientDatabaseConnectionName(
        { connections: [db("main"), db("cte-store")] },
        "cte-store",
      ),
    ).toBe("cte-store");
  });

  it("resolves the generic realm to the client's only database connection", () => {
    expect(
      resolveClientDatabaseConnectionName(
        { connections: [email, db("main")] },
        "Username-Password-Authentication",
      ),
    ).toBe("main");
    expect(
      resolveClientDatabaseConnectionName({ connections: [email, db("main")] }),
    ).toBe("main");
  });

  it("prefers a client connection named like the generic realm", () => {
    expect(
      resolveClientDatabaseConnectionName(
        {
          connections: [
            db("cte-store"),
            db("Username-Password-Authentication"),
          ],
        },
        "Username-Password-Authentication",
      ),
    ).toBe("Username-Password-Authentication");
  });

  it("does not guess between several database connections", () => {
    const client = { connections: [db("main"), db("cte-store")] };
    expect(resolveClientDatabaseConnectionName(client)).toBeUndefined();
    expect(
      resolveClientDatabaseConnectionName(
        client,
        "Username-Password-Authentication",
      ),
    ).toBe("Username-Password-Authentication");
  });
});

describe("resolveDatabaseConnectionScope", () => {
  it("is unscoped for a tenant with a single database connection", async () => {
    const { env } = await getTestServer();
    expect(
      await resolveDatabaseConnectionScope(
        env.data.connections,
        "tenantId",
        "Username-Password-Authentication",
      ),
    ).toBeUndefined();
  });

  it("scopes to a database connection once the tenant has two", async () => {
    const { env } = await getTestServer();
    await env.data.connections.create("tenantId", {
      id: "cte-store",
      name: "cte-store",
      strategy: "auth0",
      options: {},
    });

    const resolved = await resolveDatabaseConnectionScope(
      env.data.connections,
      "tenantId",
      "cte-store",
    );
    expect(resolved?.name).toBe("cte-store");
    expect([...(resolved?.databaseConnectionNames ?? [])].sort()).toEqual([
      "Username-Password-Authentication",
      "cte-store",
    ]);
  });

  it("is unscoped for a name that is not a database connection", async () => {
    const { env } = await getTestServer();
    await env.data.connections.create("tenantId", {
      id: "cte-store",
      name: "cte-store",
      strategy: "auth0",
      options: {},
    });

    expect(
      await resolveDatabaseConnectionScope(
        env.data.connections,
        "tenantId",
        "Email",
      ),
    ).toBeUndefined();
    expect(
      await resolveDatabaseConnectionScope(
        env.data.connections,
        "tenantId",
        "does-not-exist",
      ),
    ).toBeUndefined();
    expect(
      await resolveDatabaseConnectionScope(
        env.data.connections,
        "tenantId",
        undefined,
      ),
    ).toBeUndefined();
  });
});
