import { describe, expect, it } from "vitest";
import { testClient } from "hono/testing";
import { nanoid } from "nanoid";
import {
  AuthorizationResponseMode,
  Connection,
} from "@authhero/adapter-interfaces";
import { getTestServer } from "./helpers/test-server";
import { getAdminToken } from "./helpers/token";
import { readAuth0SourceCredentials } from "../src/authentication-flows/auth0-migration";
import type { StrategyHandler } from "../src/strategies";

// A provider-issued secret pasted with a trailing newline (or a leading
// space) is a common copy-paste error that later fails the upstream call.
const PADDED = "  s3cret-value\n";
const TRIMMED = "s3cret-value";

async function setup() {
  const { managementApp, oauthApp, env } = await getTestServer();
  const token = await getAdminToken();
  const send = (method: string, path: string, body: unknown) =>
    managementApp.request(
      path,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "tenant-id": "tenantId",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      env,
    );
  return { managementApp, oauthApp, env, send };
}

describe("credential trimming in the management API", () => {
  it("trims connection secrets on create and update", async () => {
    const { env, send } = await setup();

    const created = await send("POST", "/connections", {
      name: "trim-oidc",
      strategy: "oidc",
      options: {
        client_id: "client",
        client_secret: PADDED,
        configuration: { client_secret: `\t${TRIMMED} ` },
      },
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    let stored = await env.data.connections.get("tenantId", id);
    expect(stored?.options.client_secret).toBe(TRIMMED);
    expect(stored?.options.configuration?.client_secret).toBe(TRIMMED);

    const patched = await send("PATCH", `/connections/${id}`, {
      options: { client_id: "client", client_secret: " rotated\n" },
    });
    expect(patched.status).toBe(200);
    stored = await env.data.connections.get("tenantId", id);
    expect(stored?.options.client_secret).toBe("rotated");
  });

  it("keeps inner whitespace and leaves a whitespace-only secret as not set", async () => {
    const { env, send } = await setup();

    const created = await send("POST", "/connections", {
      name: "trim-twilio",
      strategy: "sms",
      options: {
        twilio_sid: " AC123 ",
        twilio_token: "a b\n",
        app_secret: " ",
      },
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const stored = await env.data.connections.get("tenantId", id);
    expect(stored?.options.twilio_sid).toBe("AC123");
    expect(stored?.options.twilio_token).toBe("a b");
    expect(stored?.options.app_secret ?? "").toBe("");
  });

  it("trims email provider keys but not the SMTP password", async () => {
    const { env, send } = await setup();

    const updated = await send("PATCH", "/email/providers", {
      name: "mailgun",
      credentials: { api_key: PADDED, domain: "mg.example.com" },
    });
    expect(updated.status).toBe(200);
    expect(
      (await env.data.emailProviders.get("tenantId"))?.credentials,
    ).toMatchObject({ api_key: TRIMMED, domain: "mg.example.com" });

    const patched = await send("PATCH", "/email/providers", {
      name: "smtp",
      credentials: {
        smtp_host: "smtp.example.com",
        smtp_user: "user",
        smtp_pass: " chosen password ",
      },
    });
    expect(patched.status).toBe(200);
    expect(
      (await env.data.emailProviders.get("tenantId"))?.credentials.smtp_pass,
    ).toBe(" chosen password ");
  });

  it("trims log stream sink credentials on create and update", async () => {
    const { env, send } = await setup();

    const created = await send("POST", "/log-streams", {
      name: "firehose",
      type: "firehose",
      status: "active",
      sink: {
        aws_region: "eu-north-1",
        delivery_stream_name: "authhero-logs",
        aws_access_key_id: " AKIDEXAMPLE\n",
        aws_secret_access_key: PADDED,
      },
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    let stored = await env.data.logStreams.get("tenantId", id);
    expect(stored?.sink.aws_access_key_id).toBe("AKIDEXAMPLE");
    expect(stored?.sink.aws_secret_access_key).toBe(TRIMMED);

    const patched = await send("PATCH", `/log-streams/${id}`, {
      sink: {
        aws_region: "eu-north-1",
        delivery_stream_name: "authhero-logs",
        aws_access_key_id: "AKIDEXAMPLE",
        aws_secret_access_key: " rotated\n",
      },
    });
    expect(patched.status).toBe(200);
    stored = await env.data.logStreams.get("tenantId", id);
    expect(stored?.sink.aws_secret_access_key).toBe("rotated");
  });

  it("keeps the stored log stream secret when the update sends only whitespace", async () => {
    const { env, send } = await setup();

    const created = await send("POST", "/log-streams", {
      name: "http",
      type: "http",
      status: "active",
      sink: {
        http_endpoint: "https://logs.example.com",
        http_authorization: `Bearer ${TRIMMED}\n`,
      },
    });
    const { id } = (await created.json()) as { id: string };

    const patched = await send("PATCH", `/log-streams/${id}`, {
      sink: {
        http_endpoint: "https://logs.example.com",
        http_authorization: "  ",
      },
    });
    expect(patched.status).toBe(200);
    const stored = await env.data.logStreams.get("tenantId", id);
    expect(stored?.sink.http_authorization).toBe(`Bearer ${TRIMMED}`);
  });

  it("trims a resource server signing secret", async () => {
    const { env, send } = await setup();

    const created = await send("POST", "/resource-servers", {
      name: "API",
      identifier: "https://api.example.com",
      signing_alg: "HS256",
      signing_secret: PADDED,
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const stored = await env.data.resourceServers.get("tenantId", id);
    expect(stored?.signing_secret).toBe(TRIMMED);
  });
});

describe("credential trimming at the upstream call", () => {
  it("hands the strategy a trimmed secret even when the stored one is padded", async () => {
    const { oauthApp, env } = await setup();
    const seen: (string | undefined)[] = [];
    const capture: StrategyHandler = {
      displayName: "Capture",
      logoDataUri: "",
      getRedirect: async () => ({
        redirectUrl: "https://example.com/authorize",
        code: "code",
      }),
      validateAuthorizationCodeAndGetUser: async (_ctx, connection) => {
        seen.push(connection.options.client_secret);
        return { sub: "capture-user", email: "capture@example.com" };
      },
    };
    env.STRATEGIES = { ...env.STRATEGIES, capture };

    // Written straight to the adapter, as a secret saved before the
    // management API trimmed on write would be.
    await env.data.connections.create("tenantId", {
      id: "captureConnection",
      name: "capture",
      strategy: "capture",
      options: { client_id: "clientId", client_secret: PADDED },
    });
    const loginSession = await env.data.loginSessions.create("tenantId", {
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      csrf_token: "csrfToken",
      authParams: {
        client_id: "clientId",
        redirect_uri: "https://example.com/callback",
        response_mode: AuthorizationResponseMode.QUERY,
      },
    });
    const state = await env.data.codes.create("tenantId", {
      code_id: nanoid(),
      code_type: "oauth2_state",
      login_id: loginSession.id,
      connection_id: "captureConnection",
      expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    });

    await testClient(oauthApp, env).callback.$get({
      query: { state: state.code_id, code: "code" },
    });

    expect(seen).toEqual([TRIMMED]);
  });

  it("trims the lazy-migration upstream client secret", () => {
    const connection: Connection = {
      id: "db",
      name: "Username-Password-Authentication",
      strategy: "auth0",
      options: {
        configuration: {
          token_endpoint: "https://upstream.example.com/oauth/token",
          userinfo_endpoint: "https://upstream.example.com/userinfo",
          client_id: "client",
          client_secret: PADDED,
        },
      },
    };
    expect(readAuth0SourceCredentials(connection)?.clientSecret).toBe(TRIMMED);
  });
});
