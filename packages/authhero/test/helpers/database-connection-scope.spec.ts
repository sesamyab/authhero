import { describe, it, expect } from "vitest";
import type {
  Connection,
  ConnectionsAdapter,
  ListParams,
} from "@authhero/adapter-interfaces";
import { HTTPException } from "hono/http-exception";
import { connectionSchema } from "@authhero/adapter-interfaces";
import {
  DatabaseConnectionScope,
  isUserInConnectionScope,
  orderFallbackDatabaseConnections,
  resolveClientDatabaseConnection,
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

  it("uses the first database connection in the client's order when none is named (#1703)", () => {
    const client = { connections: [email, db("main"), db("cte-store")] };
    expect(resolveClientDatabaseConnectionName(client)).toBe("main");
    // The generic realm names no connection here, so it means the default.
    expect(
      resolveClientDatabaseConnectionName(
        client,
        "Username-Password-Authentication",
      ),
    ).toBe("main");
    expect(
      resolveClientDatabaseConnectionName({
        connections: [db("cte-store"), db("main")],
      }),
    ).toBe("cte-store");
  });

  it("rejects a named connection the client doesn't enable", () => {
    const client = { connections: [db("main")] };
    for (const name of ["cte-store", "email"]) {
      let thrown: unknown;
      try {
        resolveClientDatabaseConnection(client, name);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(HTTPException);
      expect(thrown).toHaveProperty("status", 400);
    }
  });

  it("returns the generic name for a client without a database connection", () => {
    expect(resolveClientDatabaseConnection({ connections: [email] })).toBe(
      undefined,
    );
    expect(resolveClientDatabaseConnectionName({ connections: [email] })).toBe(
      "Username-Password-Authentication",
    );
  });
});

describe("orderFallbackDatabaseConnections", () => {
  function connection(id: string, strategy: string, created_at: string) {
    return connectionSchema.parse({
      id,
      name: id,
      strategy,
      created_at,
      updated_at: created_at,
    });
  }
  const google = connection("google", "google-oauth2", "2024-01-01T00:00:00Z");
  const sms = connection("sms", "sms", "2024-01-01T00:00:00Z");
  const newer = connection("newer-db", "auth0", "2026-06-01T00:00:00Z");
  const older = connection("older-db", "auth2", "2025-06-01T00:00:00Z");
  const undated = connection("a-undated", "auth0", "");

  it("puts the oldest database connection first, keeping other slots", () => {
    expect(
      orderFallbackDatabaseConnections([google, newer, sms, older]).map(
        (c) => c.id,
      ),
    ).toEqual(["google", "older-db", "sms", "newer-db"]);
  });

  it("treats a connection without created_at as the newest, ties on id", () => {
    expect(
      orderFallbackDatabaseConnections([undated, newer]).map((c) => c.id),
    ).toEqual(["newer-db", "a-undated"]);
    const a = connection("a-db", "auth0", "2025-01-01T00:00:00Z");
    const b = connection("b-db", "auth0", "2025-01-01T00:00:00Z");
    expect(orderFallbackDatabaseConnections([b, a]).map((c) => c.id)).toEqual([
      "a-db",
      "b-db",
    ]);
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

describe("resolveDatabaseConnectionScope paging", () => {
  it("includes database connections beyond the first page", async () => {
    const make = (name: string): Connection => ({
      id: name,
      name,
      strategy: "auth0",
      options: {},
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    const all = ["a", "b", "c", "d"].map(make);
    // The parameterless read returns one adapter page of two rows; explicit
    // pages follow page/per_page.
    const connections: Pick<ConnectionsAdapter, "list"> = {
      list: async (_tenantId: string, params?: ListParams) => {
        const perPage = params?.per_page ?? 2;
        const page = params?.page ?? 0;
        const rows = all.slice(page * perPage, (page + 1) * perPage);
        return {
          connections: rows,
          start: page * perPage,
          limit: perPage,
          length: rows.length,
        };
      },
    };

    const resolved = await resolveDatabaseConnectionScope(
      connections,
      "tenantId",
      "a",
    );
    expect([...(resolved?.databaseConnectionNames ?? [])].sort()).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });
});
