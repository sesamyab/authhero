import { describe, it, expect } from "vitest";
import { testClient } from "hono/testing";
import { getTestServer } from "../helpers/test-server";
import { getAdminToken } from "../helpers/token";

// Management API logs name the edited user in `user_id` (as Auth0 does), so
// the caller has to be carried separately in `details.request.auth`.
describe("sapi logs - caller in details.request.auth", () => {
  async function patchSeededUser(opts: { outbox?: boolean }, token: string) {
    const server = await getTestServer({ outbox: opts.outbox });
    const client = testClient(server.managementApp, server.env);

    const target = await server.env.data.users.create("tenantId", {
      user_id: "email|target",
      email: "target@example.com",
      email_verified: false,
      connection: "email",
      provider: "email",
      is_social: false,
    });

    const response = await client.users[":user_id"].$patch(
      {
        json: { email_verified: true },
        header: { "tenant-id": "tenantId" },
        param: { user_id: target.user_id },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(200);

    const { logs } = await server.env.data.logs.list("tenantId", {
      page: 0,
      per_page: 100,
      include_totals: false,
    });
    const log = logs.find(
      (l) => l.type === "sapi" && l.description === "Update a User",
    );
    expect(log).toBeDefined();
    return log!;
  }

  for (const outbox of [false, true]) {
    describe(outbox ? "outbox path" : "direct path", () => {
      it("records the admin user who made the change", async () => {
        const token = await getAdminToken({
          user_id: "email|userId",
          scope: "update:users read:users",
          jti: "token-jti",
        });

        const log = await patchSeededUser({ outbox }, token);

        expect(log.user_id).toBe("email|target");
        expect(log.details.request.auth).toEqual({
          user: {
            user_id: "email|userId",
            name: "Test User",
            email: "foo@example.com",
          },
          strategy: "jwt",
          credentials: {
            jti: "token-jti",
            scopes: ["update:users", "read:users"],
          },
        });
        // The caller's token scopes belong in auth.credentials, not in the
        // login-oriented top-level `scope`.
        expect(log.scope || "").toBe("");
      });

      it("records the client for a client-credentials token", async () => {
        // authhero mints client-credentials tokens with sub = client id and
        // no azp.
        const token = await getAdminToken({
          user_id: "clientId",
          scope: "update:users",
        });

        const log = await patchSeededUser({ outbox }, token);

        expect(log.user_id).toBe("email|target");
        expect(log.client_id).toBe("clientId");
        expect(log.details.request.auth).toEqual({
          strategy: "jwt",
          credentials: { scopes: ["update:users"] },
        });
      });

      it("keeps the user id when the caller can't be resolved", async () => {
        const token = await getAdminToken({ user_id: "auth0|elsewhere" });

        const log = await patchSeededUser({ outbox }, token);

        expect(log.details.request.auth?.user).toEqual({
          user_id: "auth0|elsewhere",
        });
      });
    });
  }
});
