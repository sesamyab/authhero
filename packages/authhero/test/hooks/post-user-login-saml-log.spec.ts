import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  AuthorizationResponseMode,
  LogTypes,
  User,
} from "@authhero/adapter-interfaces";
import { postUserLoginHook } from "../../src/hooks";
import { flushBackgroundPromises } from "../../src/helpers/wait-until";
import { drainOutbox } from "../../src/helpers/outbox-relay";
import { LogsDestination } from "../../src/helpers/outbox-destinations/logs";
import { Bindings, Variables } from "../../src/types";
import { getTestServer } from "../helpers/test-server";

describe.each([
  { path: "without the outbox", outbox: false },
  { path: "through the outbox relay", outbox: true },
])("Successful Login for a SAML client $path", ({ outbox }) => {
  it("is logged against the SAML client with the login session id", async () => {
    const server = await getTestServer({ outbox });

    const user: User = {
      user_id: "auth2|saml-user",
      email: "saml@example.com",
      email_verified: true,
      provider: "auth2",
      connection: "Username-Password-Authentication",
      is_social: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_ip: "",
      last_login: "",
      login_count: 0,
    };
    await server.env.data.users.create("tenantId", user);

    const loginSession = await server.env.data.loginSessions.create(
      "tenantId",
      {
        csrf_token: "csrf",
        authParams: {
          client_id: "clientId",
          response_mode: AuthorizationResponseMode.SAML_POST,
          redirect_uri: "https://example.com/callback",
          state: JSON.stringify({ requestId: "_req", relayState: "rs" }),
        },
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      },
    );

    const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    app.get("/saml-login", async (ctx) => {
      Object.assign(ctx.env, server.env);
      ctx.set("tenant_id", "tenantId");
      ctx.set("ip", "1.2.3.4");
      ctx.set("useragent", "test");
      ctx.set("client_id", "clientId");

      await postUserLoginHook(
        ctx,
        server.env.data,
        "tenantId",
        user,
        loginSession,
        {
          client: {
            id: "clientId",
            name: "SAML SP",
            client_id: "clientId",
            tenant: { id: "tenantId" },
            callbacks: ["https://example.com/callback"],
            allowed_logout_urls: [],
            web_origins: [],
            grant_types: ["authorization_code" as const],
            connections: [],
          } as never,
          authParams: loginSession.authParams,
        },
      );

      await Promise.all(ctx.var.outboxEventPromises ?? []);
      await flushBackgroundPromises(ctx);
      return ctx.text("ok");
    });

    const res = await app.request("/saml-login", { method: "GET" }, server.env);
    expect(res.status).toBe(200);

    if (outbox) {
      await drainOutbox(server.env.data.outbox!, [
        new LogsDestination(server.env.data.logs),
      ]);
    }

    const { logs } = await server.env.data.logs.list("tenantId", {
      page: 0,
      per_page: 100,
      include_totals: true,
    });
    const success = logs.filter((l) => l.type === LogTypes.SUCCESS_LOGIN);
    expect(success).toHaveLength(1);
    expect(success[0]!.client_id).toBe("clientId");
    expect(success[0]!.user_id).toBe("auth2|saml-user");
    expect(success[0]!.details?.login_session_id).toBe(loginSession.id);
  });
});
