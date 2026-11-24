import { beforeEach, describe, expect, it, vi } from "vitest";
import { HTTPException } from "hono/http-exception";
import { getTestServer } from "../../helpers/test-server";
import { u2Screen } from "../../helpers/u2-screen";
import { AuthError } from "../../../src/types/AuthError";
import en from "../../../locales/en.json";
import sv from "../../../locales/sv.json";
import { JSONHTTPException } from "../../../src/errors/json-http-exception";

const pw = en["login-password"]["login-password"];
const svPw = sv["login-password"]["login-password"];
const otp = en["email-otp-challenge"]["email-otp-challenge"];
const svOtp = sv["email-otp-challenge"]["email-otp-challenge"];

// The flows below are mocked so each test can raise the exact server error
// and check how the screen presents it.
const flows = vi.hoisted(() => ({
  loginWithPassword: vi.fn(),
  passwordlessGrant: vi.fn(),
}));

vi.mock("../../../src/authentication-flows/password", async (orig) => ({
  ...(await orig<
    typeof import("../../../src/authentication-flows/password")
  >()),
  loginWithPassword: flows.loginWithPassword,
}));
vi.mock("../../../src/authentication-flows/passwordless", async (orig) => ({
  ...(await orig<
    typeof import("../../../src/authentication-flows/passwordless")
  >()),
  passwordlessGrant: flows.passwordlessGrant,
}));

async function post(
  screen: "enter-password" | "login/email-otp-challenge",
  form: Record<string, string>,
  locale?: string,
) {
  const { u2App, env } = await getTestServer({ mockEmail: true });
  const session = await env.data.loginSessions.create("tenantId", {
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    csrf_token: "csrf",
    authParams: {
      client_id: "clientId",
      redirect_uri: "https://example.com/callback",
      username: "foo@example.com",
      ...(locale ? { ui_locales: locale } : {}),
    },
  });
  const response = await u2Screen(u2App, env, screen).$post({
    query: { state: session.id },
    form,
  });
  return response.text();
}

describe("password screen error mapping", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ["INVALID_CREDENTIALS", pw["wrong-credentials"]],
    ["TOO_MANY_REQUESTS", pw.tooManyRequests],
    ["USER_BLOCKED", pw["user-blocked"]],
    ["TOO_MANY_FAILED_LOGINS", pw["user-blocked"]],
  ])("maps %s to localized text", async (code, expected) => {
    flows.loginWithPassword.mockRejectedValue(
      new AuthError(400, { message: "English server text", code }),
    );
    const html = await post("enter-password", { password: "x" });
    expect(html).toContain(expected);
    expect(html).not.toContain("English server text");
  });

  it("localizes the error to the session's language", async () => {
    flows.loginWithPassword.mockRejectedValue(
      new AuthError(400, {
        message: "English server text",
        code: "TOO_MANY_REQUESTS",
      }),
    );
    const html = await post("enter-password", { password: "x" }, "sv");
    expect(html).toContain(svPw.tooManyRequests);
  });

  it("shows a hook's uncoded deny reason as is", async () => {
    flows.loginWithPassword.mockRejectedValue(
      new AuthError(403, { message: "Denied by hook" }),
    );
    expect(await post("enter-password", { password: "x" })).toContain(
      "Denied by hook",
    );
  });
});

describe("email code screen error mapping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows the translated message for a wrong or expired code", async () => {
    flows.passwordlessGrant.mockRejectedValue(
      new JSONHTTPException(403, {
        message: "Code not found or expired",
        userSafe: true,
      }),
    );
    const html = await post("login/email-otp-challenge", { code: "000000" });
    expect(html).toContain(otp["invalid-code"]);
    expect(html).not.toContain("Code not found or expired");
  });

  it("localizes the wrong or expired code message", async () => {
    flows.passwordlessGrant.mockRejectedValue(
      new JSONHTTPException(403, { message: "x", userSafe: true }),
    );
    const html = await post("login/email-otp-challenge", { code: "0" }, "sv");
    expect(html).toContain(svOtp["invalid-code"]);
  });

  it("falls back to English for a locale the code screen lacks", async () => {
    flows.passwordlessGrant.mockRejectedValue(
      new JSONHTTPException(403, { message: "x", userSafe: true }),
    );
    const html = await post("login/email-otp-challenge", { code: "0" }, "xx");
    expect(html).toContain(otp["invalid-code"]);
  });

  it("maps a rate limit to the too-many-requests text", async () => {
    flows.passwordlessGrant.mockRejectedValue(
      new HTTPException(429, { message: "rate limited" }),
    );
    const html = await post("login/email-otp-challenge", { code: "000000" });
    expect(html).toContain(otp.tooManyRequests);
    expect(html).not.toContain("rate limited");
  });
});
