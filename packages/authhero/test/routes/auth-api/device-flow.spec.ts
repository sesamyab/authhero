import { afterEach, describe, expect, it, vi } from "vitest";
import { GrantType } from "@authhero/adapter-interfaces";
import { getTestServer, type TestServer } from "../../helpers/test-server";
import { u2Screen } from "../../helpers/u2-screen";
import {
  hashDeviceCode,
  normalizeUserCode,
} from "../../../src/helpers/device-flow";
import { parseJWT } from "../../../src/utils/jwt";

const headers = { "tenant-id": "tenantId", "x-real-ip": "192.0.2.1" };
async function setup() {
  const server = await getTestServer({ mockEmail: true });
  await server.env.data.clients.update("tenantId", "clientId", {
    token_endpoint_auth_method: "none",
    app_type: "native",
    grant_types: [GrantType.DeviceCode, GrantType.RefreshToken],
    // Intentionally leave the client configured for classic login. Device
    // activation must keep the browser on u2 for every screen.
  });
  await server.env.data.connections.update("tenantId", "email", {
    options: { authentication_method: "code" },
  });
  return server;
}
async function issue(
  s: TestServer,
  extra: Record<string, string> = {},
  client_id = "clientId",
) {
  const response = await s.oauthApp.request(
    "/oauth/device/code",
    {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ client_id, ...extra }),
    },
    s.env,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return (await response.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    interval: number;
    expires_in: number;
  };
}
function poll(
  s: TestServer,
  device_code: string,
  client_id = "clientId",
  extra: Record<string, string> = {},
) {
  return s.oauthApp.request(
    "/oauth/token",
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: GrantType.DeviceCode,
        client_id,
        device_code,
        ...extra,
      }),
    },
    s.env,
  );
}
function stateFrom(response: Response) {
  return new URL(
    response.headers.get("location")!,
    "http://localhost",
  ).searchParams.get("state")!;
}
function cookieFrom(response: Response) {
  return response.headers.get("set-cookie")!.split(";")[0]!;
}
async function activate(
  s: TestServer,
  issued: Awaited<ReturnType<typeof issue>>,
) {
  const response = await s.oauthApp.request(
    issued.verification_uri_complete,
    { headers },
    s.env,
  );
  expect(response.status).toBe(302);
  const state = stateFrom(response);
  const cookie = cookieFrom(response);
  const entry = u2Screen(s.u2App, s.env, "device/code");
  const page = await entry.$get({
    query: { state },
    header: { ...headers, cookie },
  });
  expect(page.status, await page.clone().text()).toBe(200);
  expect(await page.text()).toContain(issued.user_code);
  const submitted = await entry.$post({
    query: { state },
    header: { ...headers, cookie },
    form: { user_code: issued.user_code.toLowerCase().replace("-", " ") },
  });
  expect(submitted.status, await submitted.clone().text()).toBe(302);
  expect(submitted.headers.get("location")).toContain("/u2/login");
  return { state: stateFrom(submitted), cookie: cookieFrom(submitted) };
}
async function signIn(
  s: TestServer,
  browser: Awaited<ReturnType<typeof activate>>,
) {
  const header = { ...headers, cookie: browser.cookie };
  const identifier = await u2Screen(s.u2App, s.env, "login/identifier").$post({
    query: { state: browser.state },
    header,
    form: { username: "foo@example.com" },
  });
  expect(identifier.status, await identifier.clone().text()).toBe(200);
  expect(await identifier.text()).toContain("email-otp-challenge");
  const emails = await s.getSentEmails();
  const code = emails.at(-1)?.data.code;
  expect(code).toBeTruthy();
  const otp = await u2Screen(s.u2App, s.env, "login/email-otp-challenge").$post(
    { query: { state: browser.state }, header, form: { code } },
  );
  expect(otp.status, await otp.clone().text()).toBe(302);
  if (otp.headers.get("location")!.startsWith("/u2/")) return otp;
  const resumed = await s.oauthApp.request(
    otp.headers.get("location")!,
    { headers: header },
    s.env,
  );
  expect(resumed.status, await resumed.clone().text()).toBe(302);
  return resumed;
}
async function decide(
  s: TestServer,
  browser: Awaited<ReturnType<typeof activate>>,
  decision: string,
) {
  return u2Screen(s.u2App, s.env, "device/confirmation").$post({
    query: { state: browser.state },
    header: { ...headers, cookie: browser.cookie },
    form: { decision },
  });
}
afterEach(() => vi.useRealTimers());

describe("OAuth device authorization (RFC 8628), u2", () => {
  it("issues hashed codes and advertises the endpoint in discovery", async () => {
    const s = await setup();
    const grant = await issue(s, { scope: "openid email" });
    expect(grant.user_code).toMatch(
      /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/,
    );
    expect(grant.device_code.length).toBeGreaterThanOrEqual(43);
    expect(grant.interval).toBe(5);
    expect(grant.expires_in).toBe(600);
    expect(new URL(grant.verification_uri).searchParams.get("tenant_id")).toBe(
      "tenantId",
    );
    const stored = await s.env.data.deviceCodes!.get(
      "tenantId",
      await hashDeviceCode(grant.device_code),
    );
    expect(stored?.status).toBe("pending");
    expect(JSON.stringify(stored)).not.toContain(grant.device_code);
    const userLookup = await s.env.data.deviceCodes!.getByUserCode(
      "tenantId",
      await hashDeviceCode(normalizeUserCode(grant.user_code)),
    );
    expect(userLookup?.device_code_hash).toBe(stored?.device_code_hash);
    const discovery = await s.oauthApp.request(
      "/.well-known/openid-configuration",
      { headers },
      s.env,
    );
    const body = await discovery.json();
    expect(body.device_authorization_endpoint).toBe(
      "http://localhost:3000/oauth/device/code",
    );
    expect(body.grant_types_supported).toContain(GrantType.DeviceCode);
  });

  it("returns pending, persists cumulative backoff, and does not issue tokens", async () => {
    const s = await setup();
    const grant = await issue(s);
    expect(await (await poll(s, grant.device_code)).json()).toMatchObject({
      error: "authorization_pending",
    });
    expect(await (await poll(s, grant.device_code)).json()).toMatchObject({
      error: "slow_down",
    });
    expect(await (await poll(s, grant.device_code)).json()).toMatchObject({
      error: "slow_down",
    });
    const row = await s.env.data.deviceCodes!.get(
      "tenantId",
      await hashDeviceCode(grant.device_code),
    );
    expect(row?.interval).toBe(15);
    vi.setSystemTime(Date.now() + 15_000);
    expect(await (await poll(s, grant.device_code)).json()).toMatchObject({
      error: "authorization_pending",
    });
  });

  it("completes code entry, actual email login and approval, then issues OIDC and refresh tokens exactly once", async () => {
    const s = await setup();
    const grant = await issue(s, { scope: "openid email offline_access" });
    const browser = await activate(s, grant);
    const resumed = await signIn(s, browser);
    expect(resumed.headers.get("location")).toContain(
      "/u2/device/confirmation",
    );
    const confirmation = await u2Screen(
      s.u2App,
      s.env,
      "device/confirmation",
    ).$get({
      query: { state: browser.state },
      header: { ...headers, cookie: browser.cookie },
    });
    expect(confirmation.status).toBe(200);
    const html = await confirmation.text();
    expect(html).toContain(grant.user_code);
    expect(html).toContain("Test Client");
    expect(html).toContain("offline_access");
    const approved = await decide(s, browser, "approve");
    expect(approved.status, await approved.clone().text()).toBe(302);
    const exchanged = await poll(s, grant.device_code);
    expect(exchanged.status, await exchanged.clone().text()).toBe(200);
    const tokens = await exchanged.json();
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.id_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    expect(parseJWT(tokens.id_token)?.payload.sub).toBe("email|userId");
    expect(parseJWT(tokens.access_token)?.payload.scope).toContain("email");
    expect(await (await poll(s, grant.device_code)).json()).toMatchObject({
      error: "invalid_grant",
    });
    const completed = await u2Screen(s.u2App, s.env, "device/complete").$get({
      query: { state: browser.state },
      header: { ...headers, cookie: browser.cookie },
    });
    expect(completed.status).toBe(200);
    const { logs } = await s.env.data.logs.list("tenantId", { per_page: 100 });
    expect(logs.some((log) => log.type === "sede")).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(grant.device_code);
    const refreshed = await s.oauthApp.request(
      "/oauth/token",
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: "clientId",
          refresh_token: tokens.refresh_token,
        }),
      },
      s.env,
    );
    expect(refreshed.status, await refreshed.clone().text()).toBe(200);
  });

  it("denies the request through a POST and returns access_denied to the device", async () => {
    const s = await setup();
    const grant = await issue(s);
    const browser = await activate(s, grant);
    await signIn(s, browser);
    expect((await decide(s, browser, "deny")).status).toBe(302);
    expect(await (await poll(s, grant.device_code)).json()).toMatchObject({
      error: "access_denied",
    });
    expect((await decide(s, browser, "approve")).status).toBe(409);
  });

  it("requires completed authentication and the activation browser's cookie", async () => {
    const s = await setup();
    const grant = await issue(s);
    const browser = await activate(s, grant);
    const noCookie = await u2Screen(
      s.u2App,
      s.env,
      "device/confirmation",
    ).$post({
      query: { state: browser.state },
      header: headers,
      form: { decision: "approve" },
    });
    expect(noCookie.status).toBe(403);
    const early = await decide(s, browser, "approve");
    expect(early.status).toBe(302);
    expect(early.headers.get("location")).toContain("/authorize/resume");
    expect(await (await poll(s, grant.device_code)).json()).toMatchObject({
      error: "authorization_pending",
    });
    await signIn(s, browser);
    const noCookieAfterLogin = await u2Screen(
      s.u2App,
      s.env,
      "device/confirmation",
    ).$post({
      query: { state: browser.state },
      header: headers,
      form: { decision: "approve" },
    });
    expect(noCookieAfterLogin.status).toBe(403);
  });

  it("returns expired_token after the device code's lifetime", async () => {
    const s = await setup();
    const grant = await issue(s);
    vi.setSystemTime(Date.now() + 601_000);
    expect(await (await poll(s, grant.device_code)).json()).toMatchObject({
      error: "expired_token",
    });
  });

  it("rejects unknown codes and binds codes to the issuing client and tenant", async () => {
    const s = await setup();
    const grant = await issue(s);
    await s.env.data.clients.create("tenantId", {
      client_id: "otherClient",
      name: "Other client",
      token_endpoint_auth_method: "none",
      app_type: "native",
      grant_types: [GrantType.DeviceCode],
    });
    expect(
      await (await poll(s, grant.device_code, "otherClient")).json(),
    ).toMatchObject({ error: "invalid_grant" });
    expect(await (await poll(s, "not-a-code")).json()).toMatchObject({
      error: "invalid_grant",
    });
    expect(
      await s.env.data.deviceCodes!.get(
        "otherTenant",
        await hashDeviceCode(grant.device_code),
      ),
    ).toBeNull();
    expect(await (await poll(s, grant.device_code)).json()).toMatchObject({
      error: "authorization_pending",
    });
  });

  it("requires explicit device grant opt-in at both endpoints", async () => {
    const s = await setup();
    const grant = await issue(s);
    await s.env.data.clients.update("tenantId", "clientId", {
      grant_types: [],
    });
    const issued = await s.oauthApp.request(
      "/oauth/device/code",
      {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ client_id: "clientId" }),
      },
      s.env,
    );
    expect(issued.status).toBe(400);
    expect(await issued.json()).toMatchObject({ error: "unauthorized_client" });
    expect(await (await poll(s, grant.device_code)).json()).toMatchObject({
      error: "unauthorized_client",
    });
  });

  it("authenticates confidential clients before polling or issuing", async () => {
    const s = await setup();
    const grant = await issue(s);
    await s.env.data.clients.update("tenantId", "clientId", {
      token_endpoint_auth_method: "client_secret_post",
    });
    expect((await poll(s, grant.device_code)).status).toBe(401);
    expect(
      (await poll(s, grant.device_code, "clientId", { client_secret: "wrong" }))
        .status,
    ).toBe(401);
    expect(
      await (
        await poll(s, grant.device_code, "clientId", {
          client_secret: "clientSecret",
        })
      ).json(),
    ).toMatchObject({ error: "authorization_pending" });
    await issue(s, { client_secret: "clientSecret" });
  });

  it("limits guesses per activation session", async () => {
    const s = await setup();
    const grant = await issue(s);
    const response = await s.oauthApp.request(
      grant.verification_uri,
      { headers },
      s.env,
    );
    const state = stateFrom(response);
    const cookie = cookieFrom(response);
    for (let i = 0; i < 5; i++) {
      const invalid = await u2Screen(s.u2App, s.env, "device/code").$post({
        query: { state },
        header: { ...headers, cookie },
        form: { user_code: "BCDF-GHJK" },
      });
      expect(invalid.status).toBe(400);
    }
    const capped = await u2Screen(s.u2App, s.env, "device/code").$post({
      query: { state },
      header: { ...headers, cookie },
      form: { user_code: grant.user_code },
    });
    expect(capped.status).toBe(429);
  });

  it("does not approve on a GET, even with a deny query parameter", async () => {
    const s = await setup();
    const grant = await issue(s);
    const browser = await activate(s, grant);
    await signIn(s, browser);
    const page = await u2Screen(s.u2App, s.env, "device/confirmation").$get({
      query: { state: browser.state, deny: "1" },
      header: { ...headers, cookie: browser.cookie },
    });
    expect(page.status).toBe(200);
    expect(await (await poll(s, grant.device_code)).json()).toMatchObject({
      error: "authorization_pending",
    });
  });
  it("waits for TOTP MFA before permitting device approval", async () => {
    const s = await setup();
    await s.env.data.tenants.update("tenantId", {
      mfa: { policy: "always", factors: { otp: true } },
    });
    const { encodeBase32 } = await import("@authhero/adapter-interfaces");
    const { generateTOTP } = await import("../../../src/utils/totp");
    const secret = crypto.getRandomValues(new Uint8Array(20));
    await s.env.data.authenticationMethods.create("tenantId", {
      user_id: "email|userId",
      type: "totp",
      totp_secret: encodeBase32(secret),
      confirmed: true,
    });
    const grant = await issue(s, { scope: "openid" });
    const browser = await activate(s, grant);
    const signedIn = await signIn(s, browser);
    expect(signedIn.headers.get("location")).toContain(
      "/u2/mfa/totp-challenge",
    );
    const early = await decide(s, browser, "approve");
    expect(early.headers.get("location")).toContain("/authorize/resume");
    const mfa = await u2Screen(s.u2App, s.env, "mfa/totp-challenge").$post({
      query: { state: browser.state },
      header: { ...headers, cookie: browser.cookie },
      form: { code: await generateTOTP(secret) },
    });
    expect(mfa.status, await mfa.clone().text()).toBe(302);
    const ready = mfa.headers.get("location")!.includes("/authorize/resume")
      ? await s.oauthApp.request(
          mfa.headers.get("location")!,
          { headers },
          s.env,
        )
      : mfa;
    expect(ready.headers.get("location")).toContain("/u2/device/confirmation");
    expect((await decide(s, browser, "approve")).status).toBe(302);
    expect((await poll(s, grant.device_code)).status).toBe(200);
  });

  it("executes post-login hooks on the browser's approval login before showing confirmation", async () => {
    const s = await setup();
    const hook = vi.fn();
    s.env.hooks = { onExecutePostLogin: hook };
    const grant = await issue(s, { scope: "openid" });
    const browser = await activate(s, grant);
    await signIn(s, browser);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0]![0].transaction.id).toBe(browser.state);
    expect(hook.mock.calls[0]![0].grant_type).toBe(GrantType.DeviceCode);
    expect((await decide(s, browser, "approve")).status).toBe(302);
    expect((await poll(s, grant.device_code)).status).toBe(200);
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("authenticates through a social connection without an OAuth redirect URI", async () => {
    const s = await setup();
    const grant = await issue(s, { scope: "openid" });
    const browser = await activate(s, grant);
    const started = await s.oauthApp.request(
      `/authorize?${new URLSearchParams({ client_id: "clientId", state: browser.state, connection: "mock-strategy" })}`,
      { headers },
      s.env,
    );
    expect(started.status, await started.clone().text()).toBe(302);
    expect(started.headers.get("location")).toContain(
      "https://example.com/authorize",
    );
    const failed = await s.oauthApp.request(
      "/callback?state=code&error=access_denied",
      { headers },
      s.env,
    );
    expect(failed.status).toBe(302);
    expect(new URL(failed.headers.get("location")!).pathname).toMatch(
      /^\/u2\/login(?:\/identifier)?$/,
    );
    const callback = await s.oauthApp.request(
      "/callback?state=code&code=foo@example.com",
      { headers },
      s.env,
    );
    expect(callback.status, await callback.clone().text()).toBe(302);
    const resumed = await s.oauthApp.request(
      callback.headers.get("location")!,
      { headers },
      s.env,
    );
    expect(resumed.status, await resumed.clone().text()).toBe(302);
    expect(resumed.headers.get("location")).toContain(
      "/u2/device/confirmation",
    );
    expect((await decide(s, browser, "approve")).status).toBe(302);
    expect((await poll(s, grant.device_code)).status).toBe(200);
  });

  it("allows only one concurrent exchange to issue tokens", async () => {
    const s = await setup();
    const grant = await issue(s, { scope: "openid offline_access" });
    const browser = await activate(s, grant);
    await signIn(s, browser);
    await decide(s, browser, "approve");
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => poll(s, grant.device_code)),
    );
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    for (const response of responses.filter((r) => r.status !== 200))
      expect(await response.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("preserves the first browser decision when another browser attempts approval", async () => {
    const s = await setup();
    const grant = await issue(s);
    const a = await activate(s, grant);
    const b = await activate(s, grant);
    await signIn(s, a);
    await signIn(s, b);
    expect((await decide(s, a, "deny")).status).toBe(302);
    expect((await decide(s, b, "approve")).status).toBe(409);
    expect(await (await poll(s, grant.device_code)).json()).toMatchObject({
      error: "access_denied",
    });
  });

  it("omits id and refresh tokens when their scopes were not requested", async () => {
    const s = await setup();
    const grant = await issue(s);
    const browser = await activate(s, grant);
    await signIn(s, browser);
    await decide(s, browser, "approve");
    const response = await poll(s, grant.device_code);
    expect(response.status).toBe(200);
    const tokens = await response.json();
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.id_token).toBeUndefined();
    expect(tokens.refresh_token).toBeUndefined();
  });

  it("rejects a blocked user after approval without issuing tokens", async () => {
    const s = await setup();
    const grant = await issue(s);
    const browser = await activate(s, grant);
    await signIn(s, browser);
    await decide(s, browser, "approve");
    await s.env.data.users.update("tenantId", "email|userId", {
      blocked: true,
    });
    expect(await (await poll(s, grant.device_code)).json()).toMatchObject({
      error: "access_denied",
    });
  });
  it("supports confidential Basic authentication and form-encoded token requests", async () => {
    const s = await setup();
    await s.env.data.clients.update("tenantId", "clientId", {
      token_endpoint_auth_method: "client_secret_basic",
    });
    const authorization = `basic ${btoa("clientId:clientSecret")}`;
    const response = await s.oauthApp.request(
      "/oauth/device/code",
      {
        method: "POST",
        headers: {
          ...headers,
          authorization,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ scope: "openid" }),
      },
      s.env,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const grant = await response.json();
    const browser = await activate(s, grant);
    await signIn(s, browser);
    await decide(s, browser, "approve");
    const token = await s.oauthApp.request(
      "/oauth/token",
      {
        method: "POST",
        headers: {
          ...headers,
          authorization,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: GrantType.DeviceCode,
          device_code: grant.device_code,
        }),
      },
      s.env,
    );
    expect(token.status, await token.clone().text()).toBe(200);
    expect((await token.json()).id_token).toBeTruthy();
  });
  it("optionally generates an SVG QR image for form and JSON requests", async () => {
    const s = await setup();
    for (const include of [true, false]) {
      for (const json of [true, false]) {
        const body = {
          client_id: "clientId",
          include_qr_code: json ? include : String(include),
        };
        const response = await s.oauthApp.request(
          "/oauth/device/code",
          {
            method: "POST",
            headers: {
              ...headers,
              "content-type": json
                ? "application/json"
                : "application/x-www-form-urlencoded",
            },
            body: json
              ? JSON.stringify(body)
              : new URLSearchParams(body as Record<string, string>),
          },
          s.env,
        );
        expect(response.status).toBe(200);
        const grant = await response.json();
        if (include) {
          expect(grant.qr_code).toMatch(/^data:image\/svg\+xml;base64,/);
          expect(atob(grant.qr_code.split(",")[1])).toContain("<svg");
        } else expect(grant.qr_code).toBeUndefined();
      }
    }
    expect(((await issue(s)) as { qr_code?: string }).qr_code).toBeUndefined();
  });
});
