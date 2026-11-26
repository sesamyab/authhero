/**
 * #1733 parity check: u2 input types match what the legacy /u pages used.
 */
import { describe, it, expect } from "vitest";
import { Strategy } from "@authhero/adapter-interfaces";
import { getTestServer } from "../../helpers/test-server";

type TestServer = Awaited<ReturnType<typeof getTestServer>>;
type Component = {
  id: string;
  type: string;
  label?: string;
  config?: Record<string, unknown>;
};

async function startLogin(server: TestServer, username?: string) {
  const { env, oauthApp } = server;
  const authorize = await oauthApp.request(
    `/authorize?${new URLSearchParams({
      client_id: "clientId",
      redirect_uri: "https://example.com/callback",
      state: "state",
      nonce: "nonce",
      scope: "openid",
      response_type: "code",
    })}`,
    { headers: { "tenant-id": "tenantId" } },
    env,
  );
  const state = new URL(
    `https://example.com${authorize.headers.get("location")}`,
  ).searchParams.get("state")!;
  if (username) {
    const loginSession = await env.data.loginSessions.get("tenantId", state);
    await env.data.loginSessions.update("tenantId", state, {
      authParams: { ...loginSession!.authParams, username },
    });
  }
  return state;
}

async function components(
  server: TestServer,
  screenId: string,
  state: string,
): Promise<Component[]> {
  const response = await server.u2App.request(
    `/screen/${screenId}?state=${encodeURIComponent(state)}`,
    { headers: { "tenant-id": "tenantId" } },
    server.env,
  );
  expect(response.status).toBe(200);
  const { screen } = (await response.json()) as {
    screen: { components: Component[] };
  };
  return screen.components;
}

describe("identifier field", () => {
  it("is an email field when email is all it accepts", async () => {
    const server = await getTestServer();
    await server.env.data.clientConnections.updateByClient(
      "tenantId",
      "clientId",
      [Strategy.USERNAME_PASSWORD, "email"],
    );
    const state = await startLogin(server);
    const field = (await components(server, "identifier", state)).find(
      (c) => c.id === "username",
    );
    expect(field?.type).toBe("EMAIL");
  });

  it("takes a phone number when the client has an SMS connection", async () => {
    const server = await getTestServer();
    await server.env.data.connections.create("tenantId", {
      id: "sms",
      name: "sms",
      strategy: Strategy.SMS,
      options: {},
    });
    await server.env.data.clientConnections.updateByClient(
      "tenantId",
      "clientId",
      ["email", "sms"],
    );
    const state = await startLogin(server);
    const field = (await components(server, "identifier", state)).find(
      (c) => c.id === "username",
    );
    expect(field?.type).toBe("TEXT");
    expect(field?.label).toBe("Phone number or Email address");
  });
});

describe("code fields", () => {
  it("ask for a numeric keypad and one-time-code autofill", async () => {
    const server = await getTestServer();
    const state = await startLogin(server, "foo@example.com");
    const code = (await components(server, "email-otp-challenge", state)).find(
      (c) => c.id === "code",
    );
    expect(code?.config).toMatchObject({
      input_mode: "numeric",
      autocomplete: "one-time-code",
    });
  });
});

describe("new password fields", () => {
  it("are marked new-password on signup", async () => {
    const server = await getTestServer();
    const state = await startLogin(server);
    const fields = (await components(server, "signup", state)).filter(
      (c) => c.type === "PASSWORD",
    );
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(field.config?.autocomplete).toBe("new-password");
    }
  });
});
