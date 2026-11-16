import { describe, it, expect } from "vitest";
import {
  getPrimaryUsernamePasswordUser,
  getUsernamePasswordUser,
  isUsernamePasswordProvider,
  resolveUsernamePasswordProvider,
} from "../../src/utils/username-password-provider";
import { getTestServer } from "../helpers/test-server";

describe("isUsernamePasswordProvider", () => {
  it("matches both legacy auth2 and target auth0 values", () => {
    expect(isUsernamePasswordProvider("auth2")).toBe(true);
    expect(isUsernamePasswordProvider("auth0")).toBe(true);
  });

  it("rejects unrelated providers and missing values", () => {
    expect(isUsernamePasswordProvider("email")).toBe(false);
    expect(isUsernamePasswordProvider("sms")).toBe(false);
    expect(isUsernamePasswordProvider("google-oauth2")).toBe(false);
    expect(isUsernamePasswordProvider(undefined)).toBe(false);
    expect(isUsernamePasswordProvider(null)).toBe(false);
  });
});

describe("resolveUsernamePasswordProvider", () => {
  it("defaults to auth0 when no resolver is configured", async () => {
    const { env } = await getTestServer();
    expect(await resolveUsernamePasswordProvider(env, "tenantId")).toBe(
      "auth0",
    );
  });

  it("returns auth0 for tenants matched by the resolver", async () => {
    const { env } = await getTestServer({
      usernamePasswordProvider: ({ tenant_id }) =>
        tenant_id === "tenantId" ? "auth0" : "auth2",
    });
    expect(await resolveUsernamePasswordProvider(env, "tenantId")).toBe(
      "auth0",
    );
    expect(await resolveUsernamePasswordProvider(env, "other")).toBe("auth2");
  });
});

describe("getUsernamePasswordUser dual-read", () => {
  it("finds an auth2 user even when the tenant is now configured for auth0", async () => {
    const { env } = await getTestServer({
      usernamePasswordProvider: () => "auth0",
    });

    // Pretend this row was written before migration.
    await env.data.users.create("tenantId", {
      user_id: "auth2|legacy",
      email: "legacy@example.com",
      email_verified: true,
      provider: "auth2",
      connection: "Username-Password-Authentication",
      is_social: false,
    });

    const user = await getUsernamePasswordUser({
      env,
      tenant_id: "tenantId",
      username: "legacy@example.com",
    });
    expect(user?.user_id).toBe("auth2|legacy");
  });

  it("finds an auth0 user when the tenant has been migrated", async () => {
    const { env } = await getTestServer({
      usernamePasswordProvider: () => "auth0",
    });

    await env.data.users.create("tenantId", {
      user_id: "auth0|migrated",
      email: "new@example.com",
      email_verified: true,
      provider: "auth0",
      connection: "Username-Password-Authentication",
      is_social: false,
    });

    const user = await getUsernamePasswordUser({
      env,
      tenant_id: "tenantId",
      username: "new@example.com",
    });
    expect(user?.user_id).toBe("auth0|migrated");
  });

  it("prefers the auth2 row when both providers exist for the same email", async () => {
    // Simulates a partial backfill / Auth0 import where the same identifier
    // ended up with rows under both providers. The auth2 row carries the
    // working password, so login must keep finding it.
    const { env } = await getTestServer({
      usernamePasswordProvider: () => "auth0",
    });

    await env.data.users.create("tenantId", {
      user_id: "auth2|legacy-password",
      email: "shared@example.com",
      email_verified: true,
      provider: "auth2",
      connection: "Username-Password-Authentication",
      is_social: false,
    });
    await env.data.users.create("tenantId", {
      user_id: "auth0|imported",
      email: "shared@example.com",
      email_verified: true,
      provider: "auth0",
      connection: "Username-Password-Authentication",
      is_social: false,
    });

    const user = await getUsernamePasswordUser({
      env,
      tenant_id: "tenantId",
      username: "shared@example.com",
    });
    expect(user?.user_id).toBe("auth2|legacy-password");
  });
});

describe("getUsernamePasswordUser connection scope (#1702)", () => {
  const MAIN = "Username-Password-Authentication";
  const CTE = "cte-store";

  async function serverWithTwoDatabaseConnections() {
    const server = await getTestServer();
    await server.env.data.connections.create("tenantId", {
      id: CTE,
      name: CTE,
      strategy: "auth0",
      options: {},
    });
    return server;
  }

  it("skips a user of another database connection", async () => {
    const { env } = await serverWithTwoDatabaseConnections();
    await env.data.users.create("tenantId", {
      user_id: "auth0|exchanged",
      email: "exchanged@example.com",
      email_verified: true,
      provider: "auth0",
      connection: CTE,
      is_social: false,
    });

    const lookup = (connection?: string) =>
      getUsernamePasswordUser({
        env,
        tenant_id: "tenantId",
        username: "exchanged@example.com",
        connection,
      });

    expect(await lookup(MAIN)).toBeNull();
    expect((await lookup(CTE))?.user_id).toBe("auth0|exchanged");
    // No connection keeps the unscoped lookup.
    expect((await lookup())?.user_id).toBe("auth0|exchanged");
  });

  it("finds the right row when one email exists in two connections", async () => {
    // The provider-scoped unique index allows this pair: an auth2 row in the
    // main connection and an auth0 row in the token exchange connection.
    const { env } = await serverWithTwoDatabaseConnections();
    await env.data.users.create("tenantId", {
      user_id: "auth2|main",
      email: "both@example.com",
      email_verified: true,
      provider: "auth2",
      connection: MAIN,
      is_social: false,
    });
    await env.data.users.create("tenantId", {
      user_id: "auth0|cte",
      email: "both@example.com",
      email_verified: true,
      provider: "auth0",
      connection: CTE,
      is_social: false,
    });

    const lookup = (connection: string) =>
      getUsernamePasswordUser({
        env,
        tenant_id: "tenantId",
        username: "both@example.com",
        connection,
      });

    expect((await lookup(MAIN))?.user_id).toBe("auth2|main");
    expect((await lookup(CTE))?.user_id).toBe("auth0|cte");
  });

  it("keeps legacy rows whose connection names no database connection", async () => {
    const { env } = await serverWithTwoDatabaseConnections();
    await env.data.users.create("tenantId", {
      user_id: "auth2|legacy-literal",
      email: "literal@example.com",
      email_verified: true,
      provider: "auth2",
      connection: "auth2",
      is_social: false,
    });

    for (const connection of [MAIN, CTE]) {
      const user = await getUsernamePasswordUser({
        env,
        tenant_id: "tenantId",
        username: "literal@example.com",
        connection,
      });
      expect(user?.user_id).toBe("auth2|legacy-literal");
    }
  });

  it("does not change lookups for a tenant with one database connection", async () => {
    const { env } = await getTestServer();
    // A row naming a connection that no longer exists, read through the
    // tenant's only database connection.
    await env.data.users.create("tenantId", {
      user_id: "auth0|renamed",
      email: "renamed@example.com",
      email_verified: true,
      provider: "auth0",
      connection: "old-name",
      is_social: false,
    });

    const user = await getUsernamePasswordUser({
      env,
      tenant_id: "tenantId",
      username: "renamed@example.com",
      connection: MAIN,
    });
    expect(user?.user_id).toBe("auth0|renamed");
  });

  it("scopes the primary-user lookup too", async () => {
    const { env } = await serverWithTwoDatabaseConnections();
    await env.data.users.create("tenantId", {
      user_id: "auth0|exchanged-primary",
      username: "exchangeduser",
      email_verified: true,
      provider: "auth0",
      connection: CTE,
      is_social: false,
    });

    const lookup = (connection: string) =>
      getPrimaryUsernamePasswordUser({
        env,
        tenant_id: "tenantId",
        username: "exchangeduser",
        connection,
      });

    expect(await lookup(MAIN)).toBeNull();
    expect((await lookup(CTE))?.user_id).toBe("auth0|exchanged-primary");
  });
});
