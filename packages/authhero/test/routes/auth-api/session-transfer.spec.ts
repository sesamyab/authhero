import { afterEach, describe, expect, it, vi } from "vitest";
import { testClient } from "hono/testing";
import { parseJWT, signJWT } from "../../../src/utils/jwt";
import { z } from "@hono/zod-openapi";
import type {
  RefreshTokenInsert,
  SessionTransfer,
} from "@authhero/adapter-interfaces";
import { getTestServer } from "../../helpers/test-server";
import { getAdminToken } from "../../helpers/token";
import { createTestRefreshToken } from "../../helpers/refresh-token";
import type { HookEvent } from "../../../src/types/Hooks";

/**
 * Session transfer tokens (#1710, Auth0 "Native to Web SSO"): an application
 * exchanges its refresh token for a single-use token, and another application
 * of the same tenant presents that token to /authorize to log the browser in.
 */

type Server = Awaited<ReturnType<typeof getTestServer>>;

const TENANT = "tenantId";
const USER = "email|userId";
const SENDER = "clientId";
const SENDER_SECRET = "clientSecret";
const RECEIVER = "receiverClient";
const CALLBACK = "https://receiver.example/callback";
const AUDIENCE = "urn:localhost:session_transfer";
const TOKEN_TYPE = "urn:auth0:params:oauth:token-type:session_transfer_token";
const IP = "1.2.3.4";
const OTHER_IP = "5.6.7.8";

// Auth0's log descriptions, word for word: log queries written against Auth0
// have to keep matching.
const WARN_NOT_FOUND =
  "Single Sign-On failed: Session Transfer Token not found or expired. This may indicate token reuse or expiration.";
const WARN_DEVICE_BINDING =
  "Single Sign-On failed: Session Transfer Token device binding validation failed due to IP/ASN mismatch.";
const WARN_ORGANIZATION =
  "Single Sign-On failed: Session Transfer Token organization mismatch detected.";
const WARN_USER_MISMATCH =
  "Single Sign-On failed: Session Transfer Token user mismatch detected.";
const WARN_PARENT_NOT_FOUND =
  "Single Sign-On failed: Parent refresh token not found. Session Transfer Token won't be used for session establishment.";
// AuthHero's own, for checks Auth0 does not make.
const WARN_METHOD_NOT_ALLOWED =
  "Single Sign-On failed: Session Transfer Token authentication method is not allowed for this client.";
const WARN_CONNECTION_NOT_ENABLED =
  "Single Sign-On failed: Session Transfer Token user's connection is not enabled for this client.";
const WARN_USER_UNAVAILABLE =
  "Single Sign-On failed: Session Transfer Token user is blocked or no longer exists.";

const device = {
  last_ip: "",
  initial_ip: "",
  last_user_agent: "",
  initial_user_agent: "",
  initial_asn: "",
  last_asn: "",
};

const tokenBodySchema = z.object({
  access_token: z.string().optional(),
  issued_token_type: z.string().optional(),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  id_token: z.string().optional(),
  error: z.string().optional(),
  error_description: z.string().optional(),
});

const inOneHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

function createClient(
  server: Server,
  clientId: string,
  sessionTransfer: SessionTransfer,
) {
  return server.env.data.clients.create(TENANT, {
    client_id: clientId,
    client_secret: `${clientId}Secret`,
    name: clientId,
    callbacks: [CALLBACK],
    allowed_logout_urls: [],
    web_origins: ["https://receiver.example"],
    client_metadata: {},
    session_transfer: sessionTransfer,
  });
}

/**
 * A tenant with a sender (`clientId`) that may mint and a receiver that accepts
 * the token in the query string. Everything else is Auth0's default unless the
 * test overrides it.
 */
async function setup(
  config: { sender?: SessionTransfer; receiver?: SessionTransfer } = {},
): Promise<Server> {
  const server = await getTestServer();
  await server.env.data.clients.update(TENANT, SENDER, {
    session_transfer: {
      can_create_session_transfer_token: true,
      ...config.sender,
    },
  });
  await createClient(server, RECEIVER, {
    allowed_authentication_methods: ["query"],
    ...config.receiver,
  });
  return server;
}

let refreshTokenCount = 0;

async function seedRefreshToken(
  server: Server,
  extra: Partial<RefreshTokenInsert> = {},
) {
  refreshTokenCount += 1;
  const id = `parent-refresh-token-${refreshTokenCount}`;
  const { wireToken } = await createTestRefreshToken(server.env, TENANT, {
    id,
    login_id: "loginSessionId",
    user_id: USER,
    client_id: SENDER,
    resource_servers: [
      { audience: "https://example.com", scopes: "openid profile" },
    ],
    device,
    rotating: false,
    family_id: id,
    expires_at: inOneHour(),
    idle_expires_at: inOneHour(),
    ...extra,
  });
  return { id, wireToken };
}

function tokenRequest(
  server: Server,
  form: Record<string, string>,
  headers: Record<string, string> = {},
  url = "/oauth/token",
) {
  return server.oauthApp.request(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "tenant-id": TENANT,
        "x-real-ip": IP,
        ...headers,
      },
      body: new URLSearchParams(form).toString(),
    },
    server.env,
  );
}

interface ExchangeOptions {
  clientId?: string;
  form?: Record<string, string>;
  headers?: Record<string, string>;
}

/** The refresh token exchange that asks for a session_transfer_token. */
function requestTransferToken(
  server: Server,
  refreshToken: string,
  options: ExchangeOptions = {},
) {
  return tokenRequest(
    server,
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: options.clientId ?? SENDER,
      audience: AUDIENCE,
      ...options.form,
    },
    options.headers,
  );
}

async function mint(
  server: Server,
  options: ExchangeOptions & {
    refreshToken?: Partial<RefreshTokenInsert>;
  } = {},
) {
  const parent = await seedRefreshToken(server, options.refreshToken);
  const response = await requestTransferToken(
    server,
    parent.wireToken,
    options,
  );
  expect(response.status).toBe(200);
  const body = tokenBodySchema.parse(await response.json());
  if (!body.access_token) {
    throw new Error("The exchange returned no session_transfer_token");
  }
  return { token: body.access_token, parentId: parent.id };
}

function authorize(
  server: Server,
  query: Record<string, string> = {},
  headers: Record<string, string> = {},
  origin = "",
) {
  const params = new URLSearchParams({
    client_id: RECEIVER,
    redirect_uri: CALLBACK,
    state: "state",
    scope: "openid",
    response_type: "code",
    ...query,
  });
  return server.oauthApp.request(
    `${origin}/authorize?${params.toString()}`,
    { headers: { "x-real-ip": IP, ...headers } },
    server.env,
  );
}

function describeResponse(response: Response): string {
  return `${response.status} ${response.headers.get("location") ?? ""}`;
}

/** The authorization code of a completed login. */
function expectLoggedIn(response: Response): string {
  const location = response.headers.get("location") ?? "";
  expect(response.status, describeResponse(response)).toBe(302);
  expect(location.startsWith(`${CALLBACK}?`), describeResponse(response)).toBe(
    true,
  );
  const code = new URL(location).searchParams.get("code");
  expect(code).toBeTruthy();
  return code ?? "";
}

/** The login session id of a request that was sent to the login page. */
function expectLoginPrompt(response: Response): string {
  const location = response.headers.get("location") ?? "";
  expect(response.status, describeResponse(response)).toBe(302);
  expect(location.startsWith(CALLBACK), describeResponse(response)).toBe(false);
  expect(location).toContain("/login");
  const state = new URL(location, "http://localhost").searchParams.get("state");
  expect(state).toBeTruthy();
  return state ?? "";
}

function cookieValue(response: Response, name: string): string | undefined {
  for (const cookie of response.headers.getSetCookie()) {
    if (cookie.startsWith(`${name}=`)) {
      return cookie.slice(name.length + 1).split(";")[0];
    }
  }
  return undefined;
}

const sessionIdOf = (response: Response) =>
  cookieValue(response, `${TENANT}-auth-token`);

async function exchangeCode(server: Server, code: string, clientId = RECEIVER) {
  const response = await tokenRequest(server, {
    grant_type: "authorization_code",
    code,
    redirect_uri: CALLBACK,
    client_id: clientId,
    client_secret: `${clientId}Secret`,
  });
  return {
    status: response.status,
    body: tokenBodySchema.parse(await response.json()),
  };
}

async function refresh(server: Server, refreshToken: string) {
  const response = await tokenRequest(server, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: RECEIVER,
    client_secret: `${RECEIVER}Secret`,
  });
  return {
    status: response.status,
    body: tokenBodySchema.parse(await response.json()),
  };
}

async function logsOf(server: Server) {
  const { logs } = await server.env.data.logs.list(TENANT);
  return logs;
}

async function warnings(server: Server): Promise<string[]> {
  return (await logsOf(server))
    .filter((log) => log.type === "w")
    .map((log) => log.description ?? "");
}

async function sessionsOf(server: Server, userId = USER) {
  const { sessions } = await server.env.data.sessions.list(TENANT);
  return sessions.filter((session) => session.user_id === userId);
}

/** A second user with a live browser session. */
async function createOtherUserSession(server: Server) {
  const { data } = server.env;
  await data.users.create(TENANT, {
    user_id: "email|otherUser",
    email: "other@example.com",
    email_verified: true,
    connection: "email",
    provider: "email",
    is_social: false,
  });
  const loginSession = await data.loginSessions.create(TENANT, {
    expires_at: inOneHour(),
    csrf_token: "csrf",
    authParams: { client_id: RECEIVER },
  });
  return data.sessions.create(TENANT, {
    id: "otherUserSession",
    user_id: "email|otherUser",
    login_session_id: loginSession.id,
    clients: [RECEIVER],
    expires_at: inOneHour(),
    idle_expires_at: inOneHour(),
    device,
  });
}

describe("session transfer tokens", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("client settings in the management API", () => {
    it("fills in Auth0's defaults when a client is created with session_transfer", async () => {
      const { managementApp, env } = await getTestServer();
      const management = testClient(managementApp, env);
      const token = await getAdminToken();
      const headers = { authorization: `Bearer ${token}` };

      const created = await management.clients.$post(
        {
          json: {
            client_id: "configured",
            name: "configured",
            session_transfer: { can_create_session_transfer_token: true },
          },
          header: { "tenant-id": TENANT },
        },
        { headers },
      );
      expect(created.status).toBe(201);
      expect((await created.json()).session_transfer).toEqual({
        can_create_session_transfer_token: true,
        enforce_cascade_revocation: true,
        allowed_authentication_methods: [],
        enforce_device_binding: "ip",
        allow_refresh_token: false,
        enforce_online_refresh_tokens: true,
        allow_onward_transfer: false,
        trust_forwarded_ip: false,
      });

      // A partial update changes only what it names.
      const patched = await management.clients[":id"].$patch(
        {
          param: { id: "configured" },
          json: {
            session_transfer: {
              allowed_authentication_methods: ["cookie", "query"],
              enforce_device_binding: "asn",
            },
          },
          header: { "tenant-id": TENANT },
        },
        { headers },
      );
      expect(patched.status).toBe(200);

      const fetched = await management.clients[":id"].$get(
        { param: { id: "configured" }, header: { "tenant-id": TENANT } },
        { headers },
      );
      expect(fetched.status).toBe(200);
      expect((await fetched.json()).session_transfer).toEqual({
        can_create_session_transfer_token: true,
        enforce_cascade_revocation: true,
        allowed_authentication_methods: ["cookie", "query"],
        enforce_device_binding: "asn",
        allow_refresh_token: false,
        enforce_online_refresh_tokens: true,
        allow_onward_transfer: false,
        trust_forwarded_ip: false,
      });
    });

    it("leaves an unconfigured client unconfigured when its empty object is saved back", async () => {
      const { managementApp, env } = await getTestServer();
      const management = testClient(managementApp, env);
      const token = await getAdminToken();
      const headers = { authorization: `Bearer ${token}` };

      const created = await management.clients.$post(
        {
          json: { client_id: "plain", name: "plain" },
          header: { "tenant-id": TENANT },
        },
        { headers },
      );
      expect(created.status).toBe(201);
      expect((await created.json()).session_transfer).toEqual({});

      const patched = await management.clients[":id"].$patch(
        {
          param: { id: "plain" },
          json: { name: "renamed", session_transfer: {} },
          header: { "tenant-id": TENANT },
        },
        { headers },
      );
      expect(patched.status).toBe(200);
      const body = await patched.json();
      expect(body.name).toBe("renamed");
      expect(body.session_transfer).toEqual({});
    });

    it("rejects values outside the schema", async () => {
      const { managementApp, env } = await getTestServer();
      const token = await getAdminToken();

      const response = await managementApp.request(
        "/clients",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "tenant-id": TENANT,
          },
          body: JSON.stringify({
            client_id: "invalid",
            name: "invalid",
            session_transfer: { enforce_device_binding: "mac" },
          }),
        },
        env,
      );

      expect(response.status).toBe(400);
    });
  });

  describe("minting", () => {
    it("returns Auth0's response and stores only the token's hash", async () => {
      const server = await setup();
      const parent = await seedRefreshToken(server);

      const response = await requestTransferToken(server, parent.wireToken);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.getSetCookie()).toEqual([]);
      const body = tokenBodySchema.parse(await response.json());
      expect(body).toMatchObject({
        issued_token_type: TOKEN_TYPE,
        token_type: "N_A",
        expires_in: 60,
      });
      // Opaque: not a JWT, and not something the database can give back.
      const token = body.access_token ?? "";
      expect(token.length).toBeGreaterThanOrEqual(43);
      expect(token.split(".")).toHaveLength(1);
      expect(
        await server.env.data.codes.get(
          TENANT,
          token,
          "session_transfer_token",
        ),
      ).toBeNull();
      // The user had `openid`, so the refresh still returns an ID token.
      expect(parseJWT(body.id_token ?? "")?.payload).toMatchObject({
        sub: USER,
      });
      // Not rotating: as on any AuthHero refresh, the client gets back the
      // refresh token it already holds.
      expect(body.refresh_token).toBe(parent.wireToken);

      const success = (await logsOf(server)).find(
        (log) => log.type === "sertft",
      );
      expect(success).toMatchObject({ audience: AUDIENCE, user_id: USER });
    });

    it("returns the rotated refresh token alongside the transfer token", async () => {
      const server = await setup();
      const parent = await seedRefreshToken(server, { rotating: true });

      const response = await requestTransferToken(server, parent.wireToken);

      expect(response.status).toBe(200);
      const body = tokenBodySchema.parse(await response.json());
      expect(body.issued_token_type).toBe(TOKEN_TYPE);
      expect(body.refresh_token).toBeTruthy();
      expect(body.refresh_token).not.toBe(parent.wireToken);

      // The token follows the rotation family, so it survives the rotation
      // that minted it.
      expectLoggedIn(
        await authorize(server, {
          session_transfer_token: body.access_token ?? "",
        }),
      );
    });

    it("refuses a client that may not create session transfer tokens", async () => {
      const server = await setup({
        sender: { can_create_session_transfer_token: false },
      });
      const parent = await seedRefreshToken(server);

      const response = await requestTransferToken(server, parent.wireToken);

      expect(response.status).toBe(403);
      expect(tokenBodySchema.parse(await response.json())).toMatchObject({
        error: "unauthorized_client",
      });
      const failure = (await logsOf(server)).find(
        (log) => log.type === "fertft",
      );
      expect(failure).toMatchObject({ audience: AUDIENCE });

      // The refresh token was not spent on the refused request.
      const plain = await tokenRequest(server, {
        grant_type: "refresh_token",
        refresh_token: parent.wireToken,
        client_id: SENDER,
      });
      expect(plain.status).toBe(200);
    });

    it.each(["spa", "native", "regular_web"] as const)(
      "lets a %s application mint",
      async (appType) => {
        const server = await setup();
        await server.env.data.clients.update(TENANT, SENDER, {
          app_type: appType,
        });

        const { token } = await mint(server);

        expectLoggedIn(
          await authorize(server, { session_transfer_token: token }),
        );
      },
    );
  });

  describe("redeeming at /authorize", () => {
    it("logs the browser in as the token's user", async () => {
      const server = await setup();
      const { token, parentId } = await mint(server);

      const response = await authorize(server, {
        session_transfer_token: token,
      });

      const code = expectLoggedIn(response);
      // The browser gets the session, so later requests are plain SSO.
      const sessionId = sessionIdOf(response);
      expect(sessionId).toBeTruthy();
      const session = await server.env.data.sessions.get(
        TENANT,
        sessionId ?? "",
      );
      expect(session).toMatchObject({
        user_id: USER,
        clients: [RECEIVER],
        session_transfer: {
          client_id: SENDER,
          family_id: parentId,
          cascade_revocation: true,
        },
      });

      const { status, body } = await exchangeCode(server, code);
      expect(status).toBe(200);
      expect(parseJWT(body.id_token ?? "")?.payload).toMatchObject({
        sub: USER,
        aud: RECEIVER,
      });

      expect(await warnings(server)).toEqual([]);
      expectLoggedIn(
        await authorize(
          server,
          {},
          { cookie: `${TENANT}-auth-token=${sessionId}` },
        ),
      );
    });

    it("completes silent authentication with the token", async () => {
      const server = await setup();
      const { token } = await mint(server);

      const response = await authorize(server, {
        session_transfer_token: token,
        prompt: "none",
        response_mode: "web_message",
      });

      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('"code":"');
      expect(html).not.toContain("login_required");
      expect(sessionIdOf(response)).toBeTruthy();
    });

    it("accepts a token minted on another domain of the tenant", async () => {
      const server = await setup();
      const parent = await seedRefreshToken(server);
      const minted = await tokenRequest(
        server,
        {
          grant_type: "refresh_token",
          refresh_token: parent.wireToken,
          client_id: SENDER,
          audience: "urn:auth.first.example:session_transfer",
        },
        {},
        "https://auth.first.example/oauth/token",
      );
      expect(minted.status).toBe(200);
      const token = tokenBodySchema.parse(await minted.json()).access_token;

      const response = await authorize(
        server,
        { session_transfer_token: token ?? "" },
        {},
        "https://login.second.example",
      );

      expectLoggedIn(response);
    });

    it("works only once", async () => {
      const server = await setup();
      const { token } = await mint(server);

      expectLoggedIn(
        await authorize(server, { session_transfer_token: token }),
      );
      expectLoginPrompt(
        await authorize(server, { session_transfer_token: token }),
      );

      expect(await warnings(server)).toEqual([WARN_NOT_FOUND]);
    });

    it("lets only one of two concurrent redemptions through", async () => {
      const server = await setup();
      const { token } = await mint(server);

      const responses = await Promise.all([
        authorize(server, { session_transfer_token: token }),
        authorize(server, { session_transfer_token: token }),
      ]);

      const isCallback = (response: Response) =>
        (response.headers.get("location") ?? "").startsWith(CALLBACK);
      const winners = responses.filter(isCallback);
      const losers = responses.filter((response) => !isCallback(response));
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      // The winner is a complete login and the loser an ordinary login prompt,
      // not an error page or a half-finished redirect.
      for (const winner of winners) expectLoggedIn(winner);
      for (const loser of losers) expectLoginPrompt(loser);
      expect(await sessionsOf(server)).toHaveLength(1);
    });

    it("falls through to login after 60 seconds", async () => {
      const server = await setup();
      const { token } = await mint(server);

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(Date.now() + 61_000);

      expectLoginPrompt(
        await authorize(server, { session_transfer_token: token }),
      );
      expect(await warnings(server)).toEqual([WARN_NOT_FOUND]);
    });

    it("falls through to login for a token that was never issued", async () => {
      const server = await setup();

      expectLoginPrompt(
        await authorize(server, { session_transfer_token: "made-up" }),
      );
      expect(await warnings(server)).toEqual([WARN_NOT_FOUND]);
    });

    it("leaves the token unspent when the request asks for a fresh login", async () => {
      const server = await setup();
      const { token } = await mint(server);

      expectLoginPrompt(
        await authorize(server, {
          session_transfer_token: token,
          prompt: "login",
        }),
      );
      expect(await warnings(server)).toEqual([]);

      expectLoggedIn(
        await authorize(server, { session_transfer_token: token }),
      );
    });

    describe("authentication methods", () => {
      it("refuses the token for a client that allows no method, without burning it", async () => {
        const server = await setup();
        await createClient(server, "closedClient", {});
        const { token } = await mint(server);

        expectLoginPrompt(
          await authorize(server, {
            client_id: "closedClient",
            session_transfer_token: token,
          }),
        );
        expect(await warnings(server)).toEqual([WARN_METHOD_NOT_ALLOWED]);

        // A client that does not accept tokens cannot be used to spend them.
        expectLoggedIn(
          await authorize(server, { session_transfer_token: token }),
        );
      });

      it("reads the cookie when allowed, and expires it on the way out", async () => {
        const server = await setup({
          receiver: { allowed_authentication_methods: ["cookie"] },
        });
        const { token } = await mint(server);

        const response = await authorize(
          server,
          {},
          { cookie: `auth0_session_transfer_token=${token}` },
        );

        expectLoggedIn(response);
        const cleared = response.headers
          .getSetCookie()
          .filter((cookie) =>
            cookie.startsWith("auth0_session_transfer_token="),
          );
        expect(cleared.length).toBeGreaterThan(0);
        for (const cookie of cleared) {
          expect(cookie).toMatch(/^auth0_session_transfer_token=;/);
          expect(cookie).toMatch(/Max-Age=0/i);
        }
      });

      it("refuses a query token for a cookie-only client", async () => {
        const server = await setup({
          receiver: { allowed_authentication_methods: ["cookie"] },
        });
        const { token } = await mint(server);

        expectLoginPrompt(
          await authorize(server, { session_transfer_token: token }),
        );
        expect(await warnings(server)).toEqual([WARN_METHOD_NOT_ALLOWED]);

        expectLoggedIn(
          await authorize(
            server,
            {},
            { cookie: `auth0_session_transfer_token=${token}` },
          ),
        );
      });

      it("ignores the cookie for a query-only client", async () => {
        const server = await setup();
        const { token } = await mint(server);

        const response = await authorize(
          server,
          {},
          { cookie: `auth0_session_transfer_token=${token}` },
        );

        // The browser sends the cookie to every client on the domain, so it is
        // neither an attempt nor a reason to touch the cookie.
        expectLoginPrompt(response);
        expect(await warnings(server)).toEqual([]);
        expect(
          cookieValue(response, "auth0_session_transfer_token"),
        ).toBeUndefined();

        expectLoggedIn(
          await authorize(server, { session_transfer_token: token }),
        );
      });
    });

    describe("device binding", () => {
      it("refuses a token presented from another IP address, and spends it", async () => {
        const server = await setup();
        const { token } = await mint(server);

        expectLoginPrompt(
          await authorize(
            server,
            { session_transfer_token: token },
            { "x-real-ip": OTHER_IP },
          ),
        );
        expect(await warnings(server)).toEqual([WARN_DEVICE_BINDING]);

        // An attacker's failed attempt must not leave a second try.
        expectLoginPrompt(
          await authorize(server, { session_transfer_token: token }),
        );
      });

      it("accepts another IP address when the receiver turned binding off", async () => {
        const server = await setup({
          receiver: { enforce_device_binding: "none" },
        });
        const { token } = await mint(server);

        expectLoggedIn(
          await authorize(
            server,
            { session_transfer_token: token },
            { "x-real-ip": OTHER_IP },
          ),
        );
      });

      it("refuses ASN binding when the runtime reports no ASN", async () => {
        const server = await setup({
          receiver: { enforce_device_binding: "asn" },
        });
        const { token } = await mint(server);

        expectLoginPrompt(
          await authorize(server, { session_transfer_token: token }),
        );
        expect(await warnings(server)).toEqual([WARN_DEVICE_BINDING]);
      });

      it("binds to the forwarded end-user IP for an authenticated client that opted in", async () => {
        const server = await setup({ sender: { trust_forwarded_ip: true } });

        // A backend at 9.9.9.9 exchanges on behalf of the user at 1.2.3.4.
        const { token } = await mint(server, {
          form: { client_secret: SENDER_SECRET },
          headers: { "x-real-ip": "9.9.9.9", "auth0-forwarded-for": IP },
        });

        expectLoggedIn(
          await authorize(server, { session_transfer_token: token }),
        );
      });

      it("ignores the forwarded IP on an unauthenticated exchange", async () => {
        const server = await setup({ sender: { trust_forwarded_ip: true } });

        // Anyone can call the exchange as a public client; letting them pick
        // the bound address would undo the binding.
        const { token } = await mint(server, {
          headers: { "x-real-ip": "9.9.9.9", "auth0-forwarded-for": IP },
        });

        expectLoginPrompt(
          await authorize(server, { session_transfer_token: token }),
        );
        expect(await warnings(server)).toEqual([WARN_DEVICE_BINDING]);
      });

      it("ignores the forwarded IP for a public client, even one that sends a secret", async () => {
        const server = await setup({ sender: { trust_forwarded_ip: true } });
        await server.env.data.clients.update(TENANT, SENDER, {
          token_endpoint_auth_method: "none",
        });

        // A matching secret does not make a client registered as public a
        // confidential one.
        const { token } = await mint(server, {
          form: { client_secret: SENDER_SECRET },
          headers: { "x-real-ip": "9.9.9.9", "auth0-forwarded-for": IP },
        });

        expectLoginPrompt(
          await authorize(server, { session_transfer_token: token }),
        );
        expect(await warnings(server)).toEqual([WARN_DEVICE_BINDING]);
      });

      it("ignores the forwarded IP when the client did not opt in", async () => {
        const server = await setup();

        const { token } = await mint(server, {
          form: { client_secret: SENDER_SECRET },
          headers: { "x-real-ip": "9.9.9.9", "auth0-forwarded-for": IP },
        });

        expectLoggedIn(
          await authorize(
            server,
            { session_transfer_token: token },
            { "x-real-ip": "9.9.9.9" },
          ),
        );
      });
    });

    describe("what the sender's session passes on", () => {
      const AUTHENTICATED_AT = "2026-01-01T00:00:00.000Z";
      const MFA = {
        methods: [{ name: "mfa", timestamp: AUTHENTICATED_AT, type: "totp" }],
      };

      /** A session of the sender that logged in a while ago, with MFA. */
      async function createSenderSession(server: Server) {
        const { data } = server.env;
        const loginSession = await data.loginSessions.create(TENANT, {
          expires_at: inOneHour(),
          csrf_token: "csrf",
          authParams: { client_id: SENDER },
        });
        const session = await data.sessions.create(TENANT, {
          id: "senderSession",
          user_id: USER,
          login_session_id: loginSession.id,
          clients: [SENDER],
          expires_at: inOneHour(),
          idle_expires_at: inOneHour(),
          device,
          authentication: MFA,
        });
        await data.sessions.update(TENANT, session.id, {
          authenticated_at: AUTHENTICATED_AT,
        });
        return session.id;
      }

      async function transferredSession(server: Server, senderId: string) {
        const { token } = await mint(server, {
          refreshToken: { session_id: senderId },
        });
        const response = await authorize(server, {
          session_transfer_token: token,
        });
        expectLoggedIn(response);
        return server.env.data.sessions.get(
          TENANT,
          sessionIdOf(response) ?? "",
        );
      }

      const authenticatedAtOf = (
        session: { authenticated_at: string } | null,
      ) =>
        session ? new Date(session.authenticated_at).toISOString() : undefined;

      it("carries the login time and a completed MFA from a live session", async () => {
        const server = await setup();
        const senderId = await createSenderSession(server);

        const session = await transferredSession(server, senderId);

        expect(session?.authentication).toEqual(MFA);
        expect(authenticatedAtOf(session)).toBe(AUTHENTICATED_AT);
      });

      it.each([
        ["revoked", { revoked_at: new Date().toISOString() }],
        [
          "expired",
          { expires_at: new Date(Date.now() - 60_000).toISOString() },
        ],
        [
          "idle-expired",
          { idle_expires_at: new Date(Date.now() - 60_000).toISOString() },
        ],
      ])(
        "keeps the login time but not the MFA of a session that is %s",
        async (_name, ended) => {
          const server = await setup();
          const senderId = await createSenderSession(server);
          await server.env.data.sessions.update(TENANT, senderId, ended);

          const session = await transferredSession(server, senderId);

          // A session that could no longer vouch for the second factor itself
          // cannot hand it to another application.
          expect(session?.authentication).toBeUndefined();
          // When the user logged in is still true, and forgetting it would
          // make the transferred login look fresher than it is.
          expect(authenticatedAtOf(session)).toBe(AUTHENTICATED_AT);
        },
      );
    });

    describe("signed request objects (RFC 9101)", () => {
      async function signedRequest(
        server: Server,
        claims: Record<string, string> = {},
      ) {
        const keys = await crypto.subtle.generateKey(
          {
            name: "RSASSA-PKCS1-v1_5",
            hash: "SHA-256",
            publicExponent: new Uint8Array([1, 0, 1]),
            modulusLength: 2048,
          },
          true,
          ["sign", "verify"],
        );
        const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
        await server.env.data.clients.update(TENANT, RECEIVER, {
          registration_metadata: {
            jwks: {
              keys: [
                { ...publicJwk, kid: "receiver-kid", alg: "RS256", use: "sig" },
              ],
            },
          },
        });
        return signJWT(
          "RS256",
          await crypto.subtle.exportKey("pkcs8", keys.privateKey),
          {
            iss: RECEIVER,
            aud: "http://localhost:3000/",
            client_id: RECEIVER,
            redirect_uri: CALLBACK,
            state: "state",
            scope: "openid",
            response_type: "code",
            ...claims,
          },
          {
            includeIssuedTimestamp: true,
            expiresInSeconds: 300,
            headers: { kid: "receiver-kid" },
          },
        );
      }

      it("redeems a token carried inside the request object", async () => {
        const server = await setup();
        const { token } = await mint(server);

        expectLoggedIn(
          await authorize(server, {
            request: await signedRequest(server, {
              session_transfer_token: token,
            }),
          }),
        );
        expect(await warnings(server)).toEqual([]);
      });

      it("ignores a token added outside the request object, and leaves it unspent", async () => {
        const server = await setup();
        const { token } = await mint(server);

        // Anyone can append a query parameter to a signed request; honouring
        // it would let them choose which user the browser is logged in as.
        expectLoginPrompt(
          await authorize(server, {
            request: await signedRequest(server),
            session_transfer_token: token,
          }),
        );
        expect(await warnings(server)).toEqual([]);
        expect(await sessionsOf(server)).toEqual([]);

        expectLoggedIn(
          await authorize(server, { session_transfer_token: token }),
        );
      });
    });

    it("refuses a token minted for another organization", async () => {
      const server = await setup();
      const { data } = server.env;
      const first = await data.organizations.create(TENANT, {
        name: "first-org",
        display_name: "First",
      });
      const second = await data.organizations.create(TENANT, {
        name: "second-org",
        display_name: "Second",
      });
      for (const organization of [first, second]) {
        await data.userOrganizations.create(TENANT, {
          user_id: USER,
          organization_id: organization.id,
        });
      }
      const { token } = await mint(server, {
        refreshToken: { organization: first.id },
      });

      const response = await authorize(server, {
        session_transfer_token: token,
        organization: second.id,
      });

      expect(
        (response.headers.get("location") ?? "").startsWith(CALLBACK),
      ).toBe(false);
      expect(await warnings(server)).toEqual([WARN_ORGANIZATION]);
      expect(await sessionsOf(server)).toEqual([]);
    });

    it("refuses a token whose parent refresh token was revoked", async () => {
      const server = await setup();
      const { token, parentId } = await mint(server);
      await server.env.data.refreshTokens.update(TENANT, parentId, {
        revoked_at: new Date().toISOString(),
      });

      expectLoginPrompt(
        await authorize(server, { session_transfer_token: token }),
      );
      expect(await warnings(server)).toEqual([WARN_PARENT_NOT_FOUND]);
    });

    it("refuses a token for a blocked user", async () => {
      const server = await setup();
      const { token } = await mint(server);
      await server.env.data.users.update(TENANT, USER, { blocked: true });

      expectLoginPrompt(
        await authorize(server, { session_transfer_token: token }),
      );
      expect(await warnings(server)).toEqual([WARN_USER_UNAVAILABLE]);
    });

    it("refuses a user whose connection the receiver does not offer", async () => {
      const server = await setup();
      const { data } = server.env;
      const { connections } = await data.connections.list(TENANT);
      const passwordConnection = connections.find(
        (connection) => connection.name === "Username-Password-Authentication",
      );
      await data.clientConnections.updateByClient(TENANT, RECEIVER, [
        passwordConnection?.id ?? "",
      ]);
      const { token } = await mint(server);

      expectLoginPrompt(
        await authorize(server, { session_transfer_token: token }),
      );
      expect(await warnings(server)).toEqual([WARN_CONNECTION_NOT_ENABLED]);
    });

    it("keeps an existing session of the same user", async () => {
      const server = await setup();
      const { data } = server.env;
      // An ordinary session, from a login at the receiver: it must stay one.
      const loginSession = await data.loginSessions.create(TENANT, {
        expires_at: inOneHour(),
        csrf_token: "csrf",
        authParams: { client_id: RECEIVER },
      });
      const { id: sessionId } = await data.sessions.create(TENANT, {
        id: "ordinarySession",
        user_id: USER,
        login_session_id: loginSession.id,
        clients: [RECEIVER],
        expires_at: inOneHour(),
        idle_expires_at: inOneHour(),
        device,
      });
      const before = await sessionsOf(server);
      expect(before.map((session) => session.session_transfer)).toEqual([
        undefined,
      ]);

      const response = await authorize(
        server,
        { session_transfer_token: (await mint(server)).token },
        { cookie: `${TENANT}-auth-token=${sessionId}` },
      );

      expectLoggedIn(response);
      expect(sessionIdOf(response)).toBe(sessionId);
      const after = await sessionsOf(server);
      expect(after).toHaveLength(before.length);
      // Still an ordinary session: the token's parent does not get a say in
      // a session that was not created from it.
      expect(after.map((session) => session.session_transfer)).toEqual([
        undefined,
      ]);
      expect(await warnings(server)).toEqual([]);
    });

    it("revokes a session of a different user and asks for a login", async () => {
      const server = await setup();
      const other = await createOtherUserSession(server);
      const { token } = await mint(server);

      const response = await authorize(
        server,
        { session_transfer_token: token },
        { cookie: `${TENANT}-auth-token=${other.id}` },
      );

      // Swapping accounts silently is what a login CSRF wants: neither user
      // ends up logged in.
      expectLoginPrompt(response);
      expect(await warnings(server)).toEqual([WARN_USER_MISMATCH]);
      const revoked = await server.env.data.sessions.get(TENANT, other.id);
      expect(revoked?.revoked_at).toBeTruthy();
      expect(await sessionsOf(server)).toEqual([]);
    });
  });

  describe("what a transferred login may do", () => {
    /** Log in at the receiver with a token and exchange the code. */
    async function transferLogin(server: Server, clientId = RECEIVER) {
      const { token, parentId } = await mint(server);
      const response = await authorize(server, {
        client_id: clientId,
        session_transfer_token: token,
        scope: "openid offline_access",
      });
      const code = expectLoggedIn(response);
      const exchanged = await exchangeCode(server, code, clientId);
      expect(exchanged.status).toBe(200);
      return {
        parentId,
        sessionId: sessionIdOf(response) ?? "",
        tokens: exchanged.body,
      };
    }

    it("issues no refresh token unless the receiver allows it", async () => {
      const server = await setup();

      const { tokens } = await transferLogin(server);

      // The login itself succeeds; only the refresh token is withheld.
      expect(tokens.access_token).toBeTruthy();
      expect(tokens.id_token).toBeTruthy();
      expect(tokens.refresh_token).toBeUndefined();
    });

    it("issues a refresh token that records where it came from", async () => {
      const server = await setup({ receiver: { allow_refresh_token: true } });

      const { tokens, parentId, sessionId } = await transferLogin(server);

      expect(tokens.refresh_token).toBeTruthy();
      const { refresh_tokens } = await server.env.data.refreshTokens.list(
        TENANT,
        {},
      );
      const derived = refresh_tokens.find(
        (refreshToken) => refreshToken.client_id === RECEIVER,
      );
      expect(derived).toMatchObject({
        session_id: sessionId,
        session_transfer: {
          client_id: SENDER,
          family_id: parentId,
          cascade_revocation: true,
        },
      });
      expect((await refresh(server, tokens.refresh_token ?? "")).status).toBe(
        200,
      );
    });

    it("ends an online refresh token with its session", async () => {
      const server = await setup({ receiver: { allow_refresh_token: true } });
      const { tokens, sessionId } = await transferLogin(server);

      await server.env.data.sessions.update(TENANT, sessionId, {
        revoked_at: new Date().toISOString(),
      });

      const { body } = await refresh(server, tokens.refresh_token ?? "");
      expect(body.error).toBe("invalid_grant");
    });

    it("keeps a session with a short idle lifetime alive while its refresh token is used", async () => {
      const server = await setup({ receiver: { allow_refresh_token: true } });
      // Three minutes: shorter than the five minutes the idle expiry normally
      // has to move by before it is written.
      await server.env.data.tenants.update(TENANT, {
        idle_session_lifetime: 0.05,
      });
      const { tokens, sessionId, parentId } = await transferLogin(server);
      // The sender keeps using its own refresh token: this test is about the
      // receiver's session, not about the parent going idle.
      await server.env.data.refreshTokens.update(TENANT, parentId, {
        idle_expires_at: inOneHour(),
      });
      const start = Date.now();
      const idleExpiry = async () => {
        const session = await server.env.data.sessions.get(TENANT, sessionId);
        return new Date(session?.idle_expires_at ?? 0).getTime();
      };
      const firstExpiry = await idleExpiry();

      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(start + 2 * 60_000);
      expect((await refresh(server, tokens.refresh_token ?? "")).status).toBe(
        200,
      );
      expect(await idleExpiry()).toBeGreaterThan(firstExpiry);

      // Past the original idle expiry: only the slide keeps the session, and
      // the refresh token bound to it, alive.
      vi.setSystemTime(start + 4 * 60_000);
      expect((await refresh(server, tokens.refresh_token ?? "")).status).toBe(
        200,
      );
    });

    it("lets the refresh token outlive the session when the receiver turned online tokens off", async () => {
      const server = await setup({
        receiver: {
          allow_refresh_token: true,
          enforce_online_refresh_tokens: false,
        },
      });
      const { tokens, sessionId } = await transferLogin(server);

      await server.env.data.sessions.update(TENANT, sessionId, {
        revoked_at: new Date().toISOString(),
      });

      expect((await refresh(server, tokens.refresh_token ?? "")).status).toBe(
        200,
      );
    });

    it("ends the session and its refresh tokens when the parent refresh token is revoked", async () => {
      const server = await setup({ receiver: { allow_refresh_token: true } });
      const { tokens, parentId, sessionId } = await transferLogin(server);

      await server.env.data.refreshTokens.update(TENANT, parentId, {
        revoked_at: new Date().toISOString(),
      });

      const { body } = await refresh(server, tokens.refresh_token ?? "");
      expect(body.error).toBe("invalid_grant");

      expectLoginPrompt(
        await authorize(
          server,
          {},
          { cookie: `${TENANT}-auth-token=${sessionId}` },
        ),
      );
      const session = await server.env.data.sessions.get(TENANT, sessionId);
      expect(session?.revoked_at).toBeTruthy();
    });

    it("leaves them alone when the sender turned cascade revocation off", async () => {
      const server = await setup({
        sender: { enforce_cascade_revocation: false },
        receiver: { allow_refresh_token: true },
      });
      const { tokens, parentId, sessionId } = await transferLogin(server);

      await server.env.data.refreshTokens.update(TENANT, parentId, {
        revoked_at: new Date().toISOString(),
      });

      expect((await refresh(server, tokens.refresh_token ?? "")).status).toBe(
        200,
      );
      expectLoggedIn(
        await authorize(
          server,
          {},
          { cookie: `${TENANT}-auth-token=${sessionId}` },
        ),
      );
    });

    it("cannot pass the session on unless the client allows onward transfer", async () => {
      const server = await setup({
        receiver: {
          allow_refresh_token: true,
          can_create_session_transfer_token: true,
        },
      });
      await createClient(server, "thirdClient", {
        allowed_authentication_methods: ["query"],
      });
      const { tokens, parentId } = await transferLogin(server);
      const onward = () =>
        requestTransferToken(server, tokens.refresh_token ?? "", {
          clientId: RECEIVER,
          form: { client_secret: `${RECEIVER}Secret` },
        });

      const refused = await onward();
      expect(refused.status).toBe(403);
      expect(tokenBodySchema.parse(await refused.json())).toMatchObject({
        error: "invalid_grant",
        error_description:
          "Session transfer tokens cannot be created from a transferred session",
      });

      await server.env.data.clients.update(TENANT, RECEIVER, {
        session_transfer: {
          allowed_authentication_methods: ["query"],
          allow_refresh_token: true,
          can_create_session_transfer_token: true,
          allow_onward_transfer: true,
        },
      });

      const allowed = await onward();
      expect(allowed.status).toBe(200);
      const token = tokenBodySchema.parse(await allowed.json()).access_token;
      const response = await authorize(server, {
        client_id: "thirdClient",
        session_transfer_token: token ?? "",
      });
      expectLoggedIn(response);

      // The chain stays tied to the refresh token it started from.
      const session = await server.env.data.sessions.get(
        TENANT,
        sessionIdOf(response) ?? "",
      );
      expect(session?.session_transfer).toEqual({
        client_id: RECEIVER,
        family_id: parentId,
        cascade_revocation: true,
      });
    });
  });

  describe("hooks and logs", () => {
    it("tells post-login hooks about the token and the session's origin", async () => {
      const server = await setup();
      const events: HookEvent[] = [];
      server.env.hooks = {
        onExecutePostLogin: async (event: HookEvent) => {
          events.push(event);
        },
      };
      const { token, parentId } = await mint(server, {
        headers: { "user-agent": "SenderApp/1.0" },
      });

      expectLoggedIn(
        await authorize(server, { session_transfer_token: token }),
      );

      expect(events).toHaveLength(1);
      // The hook learns that a token was used, never the token itself.
      expect(events[0]?.request?.url).toBeTruthy();
      expect(events[0]?.request?.url).not.toContain("session_transfer_token");
      expect(events[0]?.session_transfer_token).toEqual({
        client_id: SENDER,
        scope: "openid profile",
        request: { ip: IP, asn: undefined, user_agent: "SenderApp/1.0" },
      });
      expect(events[0]?.session?.session_transfer).toEqual({
        client_id: SENDER,
        parent_refresh_token: { id: parentId },
      });
    });

    it("never writes the token to logs or to the stored authorization URL", async () => {
      const server = await setup();
      const used = (await mint(server)).token;
      const rejected = (await mint(server)).token;

      expectLoggedIn(await authorize(server, { session_transfer_token: used }));
      const loginSessionId = expectLoginPrompt(
        await authorize(
          server,
          { session_transfer_token: rejected },
          { "x-real-ip": OTHER_IP },
        ),
      );

      const logs = JSON.stringify(await logsOf(server));
      expect(logs).not.toContain(used);
      expect(logs).not.toContain(rejected);

      const loginSession = await server.env.data.loginSessions.get(
        TENANT,
        loginSessionId,
      );
      expect(loginSession?.authorization_url).toBeTruthy();
      expect(loginSession?.authorization_url).not.toContain(rejected);
      expect(loginSession?.authorization_url).not.toContain(
        "session_transfer_token",
      );
    });
  });
});
