import { describe, it, expect } from "vitest";
import { Context } from "hono";
import { DataAdapters } from "@authhero/adapter-interfaces";
import { calculateScopesAndPermissions } from "../../src/helpers/scopes-permissions";
import { MANAGEMENT_API_AUDIENCE } from "../../src/middlewares/authentication";
import { MANAGEMENT_API_SCOPES } from "../../src/seed";
import { parseJWT } from "../../src/utils/jwt";
import { getTestServer, TestServer } from "../helpers/test-server";
import { Bindings, Variables } from "../../src/types";

const TENANT = "tenantId";
const USER = "email|userId";

type Ctx = Context<{ Bindings: Bindings; Variables: Variables }>;

function contextFor(env: Bindings): Ctx {
  return { env, var: {} } as Ctx;
}

/** The Management API resource server, as `seed` creates it. */
async function createManagementApi(
  data: DataAdapters,
  options: { enforce_policies: boolean; token_dialect: string } = {
    enforce_policies: true,
    token_dialect: "access_token_authz",
  },
) {
  await data.resourceServers.create(TENANT, {
    name: "Authhero Management API",
    identifier: MANAGEMENT_API_AUDIENCE,
    scopes: MANAGEMENT_API_SCOPES,
    options,
  });
}

async function grantPermission(data: DataAdapters, permission: string) {
  await data.userPermissions.create(TENANT, USER, {
    user_id: USER,
    resource_server_identifier: MANAGEMENT_API_AUDIENCE,
    permission_name: permission,
  });
}

describe("scopes for a Management API audience", () => {
  describe("calculateScopesAndPermissions", () => {
    it("drops requested scopes the resource server does not define when the user does not hold them", async () => {
      const { env } = await getTestServer();
      await createManagementApi(env.data);

      const result = await calculateScopesAndPermissions(contextFor(env), {
        tenantId: TENANT,
        clientId: "clientId",
        userId: USER,
        audience: MANAGEMENT_API_AUDIENCE,
        requestedScopes: ["openid", "auth:read", "auth:write", "users:read"],
      });

      expect(result.scopes).toEqual(["openid"]);
      expect(result.permissions).toEqual([]);
    });

    it("drops them with the access_token dialect too", async () => {
      const { env } = await getTestServer();
      await createManagementApi(env.data, {
        enforce_policies: true,
        token_dialect: "access_token",
      });

      const result = await calculateScopesAndPermissions(contextFor(env), {
        tenantId: TENANT,
        clientId: "clientId",
        userId: USER,
        audience: MANAGEMENT_API_AUDIENCE,
        requestedScopes: ["openid", "auth:read", "users:read", "read:users"],
      });

      expect(result.scopes).toEqual(["openid"]);
      expect(result.permissions).toEqual([]);
    });

    it("keeps an undefined scope the user holds as a permission", async () => {
      const { env } = await getTestServer();
      await createManagementApi(env.data);
      await grantPermission(env.data, "auth:read");

      const result = await calculateScopesAndPermissions(contextFor(env), {
        tenantId: TENANT,
        clientId: "clientId",
        userId: USER,
        audience: MANAGEMENT_API_AUDIENCE,
        requestedScopes: ["openid", "auth:read", "auth:write"],
      });

      expect(result.scopes).toEqual(["openid", "auth:read"]);
    });

    it("applies user permissions even when the resource server has RBAC turned off", async () => {
      const { env } = await getTestServer();
      await createManagementApi(env.data, {
        enforce_policies: false,
        token_dialect: "access_token",
      });
      await grantPermission(env.data, "read:clients");

      const result = await calculateScopesAndPermissions(contextFor(env), {
        tenantId: TENANT,
        clientId: "clientId",
        userId: USER,
        audience: MANAGEMENT_API_AUDIENCE,
        requestedScopes: ["openid", "read:users", "read:clients", "auth:read"],
      });

      expect(result.scopes).toEqual(["openid", "read:clients"]);
    });

    it("still puts the permissions a user holds in the permissions claim", async () => {
      const { env } = await getTestServer();
      await createManagementApi(env.data);
      await grantPermission(env.data, "read:users");

      const result = await calculateScopesAndPermissions(contextFor(env), {
        tenantId: TENANT,
        clientId: "clientId",
        userId: USER,
        audience: MANAGEMENT_API_AUDIENCE,
        requestedScopes: ["openid", "users:read"],
      });

      expect(result.scopes).toEqual(["openid"]);
      expect(result.permissions).toEqual(["read:users"]);
    });

    it("treats an audience from additionalManagementAudiences the same way", async () => {
      const { env } = await getTestServer();
      const legacyAudience = "https://tenantId.example.com/v2/api/";
      await env.data.resourceServers.create(TENANT, {
        name: "Legacy Management API",
        identifier: legacyAudience,
        scopes: [{ value: "read:users", description: "Read users" }],
        options: { enforce_policies: false, token_dialect: "access_token" },
      });
      env.additionalManagementAudiences = () => [legacyAudience];

      const result = await calculateScopesAndPermissions(contextFor(env), {
        tenantId: TENANT,
        clientId: "clientId",
        userId: USER,
        audience: legacyAudience,
        requestedScopes: ["openid", "read:users", "auth:read"],
      });

      expect(result.scopes).toEqual(["openid"]);
    });

    it("leaves other resource servers passing undefined scopes through", async () => {
      const { env } = await getTestServer();
      await env.data.resourceServers.create(TENANT, {
        name: "Other API",
        identifier: "https://other-api.example.com",
        scopes: [{ value: "read:things", description: "Read things" }],
        options: { enforce_policies: true, token_dialect: "access_token" },
      });

      const result = await calculateScopesAndPermissions(contextFor(env), {
        tenantId: TENANT,
        clientId: "clientId",
        userId: USER,
        audience: "https://other-api.example.com",
        requestedScopes: ["openid", "read:things", "entitlement"],
      });

      expect(result.scopes).toEqual(["openid", "entitlement"]);
    });
  });

  describe("through the token endpoint", () => {
    async function passwordlessToken(server: TestServer, scope: string) {
      const { oauthApp, env, getSentEmails } = server;
      const start = await oauthApp.request(
        "/passwordless/start",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_id: "clientId",
            connection: "email",
            email: "foo@example.com",
            send: "code",
            authParams: { audience: MANAGEMENT_API_AUDIENCE, scope },
          }),
        },
        env,
      );
      expect(start.status).toBe(200);
      const emails = getSentEmails();
      const otp = emails[emails.length - 1].data.code;

      const response = await oauthApp.request(
        "/oauth/token",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            grant_type: "http://auth0.com/oauth/grant-type/passwordless/otp",
            client_id: "clientId",
            username: "foo@example.com",
            otp,
            realm: "email",
          }),
        },
        env,
      );
      expect(response.status).toBe(200);
      const body: { access_token: string } = await response.json();
      return body.access_token;
    }

    function listUsers(server: TestServer, token: string) {
      return server.managementApp.request(
        "/users",
        {
          headers: { "tenant-id": TENANT, authorization: `Bearer ${token}` },
        },
        server.env,
      );
    }

    it("gives a user without permissions a token the Management API refuses", async () => {
      const server = await getTestServer();
      await createManagementApi(server.env.data);

      const token = await passwordlessToken(
        server,
        "openid auth:read auth:write users:read read:users",
      );

      const payload = parseJWT(token)?.payload;
      expect(payload?.aud).toBe(MANAGEMENT_API_AUDIENCE);
      expect(payload?.scope).toBe("openid");
      expect(payload?.permissions ?? []).toEqual([]);

      const response = await listUsers(server, token);
      expect(response.status).toBe(403);
    });

    it("gives a user with the permission a token the Management API accepts", async () => {
      const server = await getTestServer();
      await createManagementApi(server.env.data);
      await grantPermission(server.env.data, "read:users");

      const token = await passwordlessToken(server, "openid");

      const response = await listUsers(server, token);
      expect(response.status).toBe(200);
    });
  });
});
