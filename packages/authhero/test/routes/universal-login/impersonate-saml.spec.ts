import { describe, it, expect } from "vitest";
import { deflateRawSync } from "node:zlib";
import { testClient } from "hono/testing";
import { getTestServer } from "../../helpers/test-server";
import {
  AuthorizationResponseMode,
  Strategy,
} from "@authhero/adapter-interfaces";
import { USERNAME_PASSWORD_PROVIDER } from "../../../src/constants";
import { createX509Certificate } from "../../../src/utils/encryption";

const ADMIN = `${USERNAME_PASSWORD_PROVIDER}|admin123`;
const TARGET = `${USERNAME_PASSWORD_PROVIDER}|target123`;

function decode(html: string) {
  const b64 = /name="SAMLResponse" value="([^"]+)"/.exec(html)?.[1] ?? "";
  return Buffer.from(b64, "base64").toString("utf8");
}

async function setup() {
  const { universalApp, env } = await getTestServer();
  // The fixture's SAML_SIGN_URL points at a service that isn't running.
  env.samlSigner = { signSAML: async (xml) => xml };
  const key = await createX509Certificate({ name: "CN=saml" });
  await env.data.keys.create({ ...key, type: "saml_encryption" });
  await env.data.clients.update("tenantId", "clientId", {
    addons: { samlp: { recipient: "https://example.com/callback" } },
  });

  for (const [user_id, email] of [
    [ADMIN, "admin@example.com"],
    [TARGET, "target@example.com"],
  ]) {
    await env.data.users.create("tenantId", {
      user_id,
      email,
      email_verified: true,
      provider: USERNAME_PASSWORD_PROVIDER,
      connection: Strategy.USERNAME_PASSWORD,
      is_social: false,
    });
  }
  await env.data.userPermissions.create("tenantId", ADMIN, {
    user_id: ADMIN,
    resource_server_identifier: "https://api.example.com/",
    permission_name: "users:impersonate",
  });

  const loginSession = await env.data.loginSessions.create("tenantId", {
    expires_at: new Date(Date.now() + 1000 * 60 * 5).toISOString(),
    csrf_token: "csrfToken",
    authParams: {
      client_id: "clientId",
      response_mode: AuthorizationResponseMode.SAML_POST,
      redirect_uri: "https://example.com/callback",
      audience: "https://sp.example/sp",
      state: JSON.stringify({ requestId: "_abc123", relayState: "relay" }),
    },
  });
  const session = await env.data.sessions.create("tenantId", {
    id: "session123",
    user_id: ADMIN,
    login_session_id: loginSession.id,
    clients: ["clientId"],
    expires_at: new Date(Date.now() + 1000 * 60 * 60).toISOString(),
    device: {
      last_ip: "",
      initial_ip: "",
      last_user_agent: "",
      initial_user_agent: "",
      initial_asn: "",
      last_asn: "",
    },
  });
  await env.data.loginSessions.update("tenantId", loginSession.id, {
    session_id: session.id,
  });
  return { client: testClient(universalApp, env), state: loginSession.id };
}

describe("classic /u/impersonate with SAML", () => {
  it("switch returns the SAML form", async () => {
    const { client, state } = await setup();
    const res = await client.impersonate.switch.$post({
      query: { state },
      form: { user_id: TARGET },
    });
    expect(res.status).toBe(200);
    expect(decode(await res.text())).toContain("target@example.com");
  });
  it("continue returns the SAML form", async () => {
    const { client, state } = await setup();
    const res = await client.impersonate.continue.$post({ query: { state } });
    expect(res.status).toBe(200);
    expect(decode(await res.text())).toContain("admin@example.com");
  });
});

describe("SAML login with a post-login page hook", () => {
  it("shows the impersonate page, then returns the SAML form for the target", async () => {
    const { universalApp, samlApp, env } = await getTestServer({
      mockEmail: true,
    });
    env.samlSigner = { signSAML: async (xml) => xml };
    const key = await createX509Certificate({ name: "CN=saml" });
    await env.data.keys.create({ ...key, type: "saml_encryption" });
    await env.data.clients.update("tenantId", "clientId", {
      addons: { samlp: { recipient: "https://example.com/callback" } },
    });

    const bcryptjs = (await import("bcryptjs")).default;
    for (const [user_id, email] of [
      [ADMIN, "admin@example.com"],
      [TARGET, "target@example.com"],
    ]) {
      await env.data.users.create("tenantId", {
        user_id,
        email,
        email_verified: true,
        provider: USERNAME_PASSWORD_PROVIDER,
        connection: Strategy.USERNAME_PASSWORD,
        is_social: false,
      });
    }
    await env.data.passwords.create("tenantId", {
      user_id: ADMIN,
      password: await bcryptjs.hash("adminpassword123", 10),
      algorithm: "bcrypt",
      is_current: true,
    });
    await env.data.userPermissions.create("tenantId", ADMIN, {
      user_id: ADMIN,
      resource_server_identifier: "https://api.example.com/",
      permission_name: "users:impersonate",
    });

    // Page hooks aren't stored in the database; the hook runner recognizes them.
    const originalList = env.data.hooks.list;
    env.data.hooks.list = async (tenant_id, query) => {
      const result = await originalList(tenant_id, query);
      result.hooks.push({
        hook_id: "hook_impersonate_saml",
        enabled: true,
        trigger_id: "post-user-login",
        page_id: "impersonate",
        permission_required: "users:impersonate",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        synchronous: false,
      } as never);
      return result;
    };

    const xml = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_abc123" Version="2.0" IssueInstant="2026-01-01T00:00:00Z" Destination="http://localhost:3000/samlp/clientId" AssertionConsumerServiceURL="https://example.com/callback"><saml:Issuer>https://sp.example/sp</saml:Issuer></samlp:AuthnRequest>`;
    const samlResponse = await testClient(samlApp, env)[":client_id"].$get({
      param: { client_id: "clientId" },
      query: {
        SAMLRequest: deflateRawSync(Buffer.from(xml, "utf8")).toString(
          "base64",
        ),
      },
    });
    expect(samlResponse.status).toBe(302);
    const state = new URL(
      `https://example.com${samlResponse.headers.get("location")}`,
    ).searchParams.get("state")!;

    const universalClient = testClient(universalApp, env);
    await universalClient.login.identifier.$post({
      query: { state },
      form: { username: "admin@example.com" },
    });
    const passwordResponse = await universalClient["enter-password"].$post({
      query: { state },
      form: { password: "adminpassword123" },
    });
    expect(passwordResponse.status).toBe(302);
    expect(passwordResponse.headers.get("location")).toContain(
      "/u/impersonate",
    );

    const switchResponse = await universalClient.impersonate.switch.$post({
      query: { state },
      form: { user_id: TARGET },
    });
    expect(switchResponse.status).toBe(200);
    expect(decode(await switchResponse.text())).toContain("target@example.com");
  });
});
