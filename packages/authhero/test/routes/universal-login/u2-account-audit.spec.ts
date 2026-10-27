import { describe, it, expect } from "vitest";
import { getTestServer } from "../../helpers/test-server";

const caller = {
  user_id: "email|userId",
  name: "Test User",
  email: "foo@example.com",
};
const auth = { strategy: "session", user: caller };

async function setup(outbox: boolean, revoked = false) {
  const server = await getTestServer({
    outbox,
    hooks: {
      onExecutePostUserDeletion: async () => {
        throw new Error("Post-deletion failure");
      },
    },
  });
  const { env } = server;
  const loginSession = await env.data.loginSessions.create("tenantId", {
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    csrf_token: "csrf",
    authParams: {
      client_id: "clientId",
      redirect_uri: "https://example.com",
    },
  });
  await env.data.sessions.create("tenantId", {
    id: "account-session",
    user_id: caller.user_id,
    clients: ["clientId"],
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
    used_at: new Date().toISOString(),
    ...(revoked ? { revoked_at: new Date().toISOString() } : {}),
    login_session_id: loginSession.id,
    device: {
      last_ip: "",
      initial_ip: "",
      last_user_agent: "",
      initial_user_agent: "",
      initial_asn: "",
      last_asn: "",
    },
  });
  return { ...server, state: loginSession.id };
}

for (const outbox of [false, true]) {
  describe(`account audit caller (${outbox ? "outbox" : "direct"})`, () => {
    for (const screenApi of [false, true]) {
      it(`preserves the self-deletion caller through the ${screenApi ? "screen API" : "HTML form"}`, async () => {
        const { u2App, env, state } = await setup(outbox);
        const path = screenApi ? "/screen/account-delete" : "/account/delete";
        const response = await u2App.request(
          `${path}?state=${encodeURIComponent(state)}`,
          {
            method: "POST",
            headers: {
              "tenant-id": "tenantId",
              cookie: "tenantId-auth-token=account-session",
              "content-type": screenApi
                ? "application/json"
                : "application/x-www-form-urlencoded",
            },
            body: screenApi
              ? JSON.stringify({ data: { confirmation: "DELETE" } })
              : "confirmation=DELETE",
          },
          env,
        );
        expect(response.status).toBe(screenApi ? 200 : 302);
        expect(await env.data.users.get("tenantId", caller.user_id)).toBeNull();
        const session = await env.data.sessions.get(
          "tenantId",
          "account-session",
        );
        // Removing the user cascades to their sessions.
        expect(session).toBeNull();

        const { logs } = await env.data.logs.list("tenantId", {
          page: 0,
          per_page: 100,
          include_totals: false,
        });
        const deletion = logs.find((log) => log.type === "sdu");
        expect(deletion).toMatchObject({
          user_id: caller.user_id,
          user_name: caller.email,
          details: {
            request: { method: "POST", path, auth },
            login_session_id: state,
          },
        });
        if (outbox) {
          const [event] = await env.data.outbox!.getByIds([deletion!.log_id!]);
          expect(event).toMatchObject({
            category: "user_action",
            actor: { type: "user", id: caller.user_id, email: caller.email },
            request: { auth },
          });
        }
        // Logs with custom details (such as hook errors) must retain the caller too.
        const hookFailure = logs.find((log) => log.type === "fh");
        expect(hookFailure?.details).toMatchObject({
          error: "Post-deletion failure",
          request: { auth },
        });
      });
    }

    it("does not delete an account using a revoked session", async () => {
      const { u2App, env, state } = await setup(outbox, true);
      await u2App.request(
        `/screen/account-delete?state=${encodeURIComponent(state)}`,
        {
          method: "POST",
          headers: {
            "tenant-id": "tenantId",
            cookie: "tenantId-auth-token=account-session",
            "content-type": "application/json",
          },
          body: JSON.stringify({ data: { confirmation: "DELETE" } }),
        },
        env,
      );
      expect(
        await env.data.users.get("tenantId", caller.user_id),
      ).not.toBeNull();
      const { logs } = await env.data.logs.list("tenantId", {
        page: 0,
        per_page: 100,
        include_totals: false,
      });
      expect(logs.some((log) => log.type === "sdu")).toBe(false);
    });
  });
}
