import { afterEach, describe, it, expect, vi } from "vitest";
import { testClient } from "hono/testing";
import bcryptjs from "bcryptjs";
import {
  AuthorizationResponseType,
  LogTypes,
  Strategy,
} from "@authhero/adapter-interfaces";
import { getTestServer } from "../../helpers/test-server";
import { u2Screen } from "../../helpers/u2-screen";
import { USERNAME_PASSWORD_PROVIDER } from "../../../src/constants";
import {
  clearSessionNotice,
  readSessionNotice,
  setSessionNotice,
} from "../../../src/helpers/session-notice";

afterEach(() => vi.restoreAllMocks());

const EMAIL = "both@example.com";
const USER_ID = `${USERNAME_PASSWORD_PROVIDER}|bothUserId`;
const OLD_PASSWORD = "OldP@ssw0rd!";
const NEW_PASSWORD = "NewP@ssw0rd!";
const RESET_BANNER = "Your password has been reset";

/**
 * A tenant with both a password and a code-based email connection, where the
 * user last signed in with a code and `password_first` is off — the setup
 * where the identifier screen picks the OTP step.
 */
async function setup({ connectionHint }: { connectionHint?: string } = {}) {
  const server = await getTestServer({
    mockEmail: true,
    testTenantLanguage: "en",
  });
  const { env, oauthApp } = server;

  await env.data.connections.update("tenantId", Strategy.USERNAME_PASSWORD, {
    strategy: Strategy.USERNAME_PASSWORD,
  });
  // The seeded email connection sends magic links; this needs the code flow
  await env.data.connections.update("tenantId", "email", {
    options: { authentication_method: "code" },
  });
  await env.data.clientConnections.updateByClient("tenantId", "clientId", [
    Strategy.USERNAME_PASSWORD,
    "email",
  ]);
  await env.data.promptSettings.set("tenantId", {
    identifier_first: true,
    password_first: false,
  });

  await env.data.users.create("tenantId", {
    email: EMAIL,
    email_verified: true,
    connection: Strategy.USERNAME_PASSWORD,
    provider: USERNAME_PASSWORD_PROVIDER,
    is_social: false,
    user_id: USER_ID,
    app_metadata: { strategy: "email" },
  });
  await env.data.passwords.create("tenantId", {
    user_id: USER_ID,
    password: await bcryptjs.hash(OLD_PASSWORD, 10),
    algorithm: "bcrypt",
  });

  const oauthClient = testClient(oauthApp, env);
  const authorizeResponse = await oauthClient.authorize.$get({
    query: {
      client_id: "clientId",
      redirect_uri: "https://example.com/callback",
      state: "state",
      nonce: "nonce",
      scope: "openid email profile",
      response_type: AuthorizationResponseType.CODE,
      ...(connectionHint ? { connection: connectionHint } : {}),
    },
  });
  const location = authorizeResponse.headers.get("location");
  const state = new URL(`https://example.com${location}`).searchParams.get(
    "state",
  )!;

  return { ...server, state };
}

type Setup = Awaited<ReturnType<typeof setup>>;

/** Requests a reset code through the u2 screens and completes the reset. */
async function resetPasswordViaCode({
  u2App,
  env,
  state,
  getSentEmails,
}: Setup) {
  await u2Screen(u2App, env, "reset-password/request").$post({
    query: { state },
    form: { email: EMAIL },
  });
  const sentEmails = getSentEmails();
  const code = sentEmails[sentEmails.length - 1].data.code;
  if (!code) throw new Error("No reset code found in email");

  return u2Screen(u2App, env, "reset-password/code").$post({
    query: { state },
    form: {
      code,
      password: NEW_PASSWORD,
      confirm_password: NEW_PASSWORD,
    },
  });
}

function locationPath(response: Response) {
  return new URL(`https://example.com${response.headers.get("location")}`);
}

describe("password reset always lands on the password step", () => {
  it("sends users who last signed in with a code to the password step, not the OTP step", async () => {
    const ctx = await setup();
    const { u2App, env, state } = ctx;

    // Precondition: without a reset, this user would be sent to the code step
    const identifierResponse = await u2Screen(
      u2App,
      env,
      "login/identifier",
    ).$post({ query: { state }, form: { username: EMAIL } });
    expect(await identifierResponse.text()).toMatch(/code/i);

    const resetResponse = await resetPasswordViaCode(ctx);
    expect(resetResponse.status).toBe(302);
    expect(locationPath(resetResponse).pathname).toMatch(/\/enter-password$/);

    const passwordStep = await u2Screen(u2App, env, "enter-password").$get({
      query: { state },
    });
    const html = await passwordStep.text();
    expect(html).toContain(RESET_BANNER);
    expect(html).not.toMatch(/email-otp-challenge/);
  });

  it("still lands on the password step when the login started with connection=email", async () => {
    const ctx = await setup({ connectionHint: "email" });

    const resetResponse = await resetPasswordViaCode(ctx);

    expect(resetResponse.status).toBe(302);
    expect(locationPath(resetResponse).pathname).toMatch(/\/enter-password$/);
  });

  it("lets the user sign in with the new password from that step", async () => {
    const ctx = await setup();
    const { u2App, env, state } = ctx;

    await resetPasswordViaCode(ctx);

    // The old password no longer works...
    const oldPassword = await u2Screen(u2App, env, "enter-password").$post({
      query: { state },
      form: { password: OLD_PASSWORD },
    });
    expect(oldPassword.status).toBe(400);

    // ...and the new one completes the original authorize request
    const newPassword = await u2Screen(u2App, env, "enter-password").$post({
      query: { state },
      form: { password: NEW_PASSWORD },
    });
    expect(newPassword.status).toBe(302);
    const redirect = new URL(newPassword.headers.get("location")!);
    expect(redirect.origin + redirect.pathname).toBe(
      "https://example.com/callback",
    );
    expect(redirect.searchParams.get("code")).toBeTruthy();
  });

  it("shows the confirmation in the JSON screen the widget fetches", async () => {
    const ctx = await setup();
    const { u2App, env, state } = ctx;

    await resetPasswordViaCode(ctx);

    const response = await u2App.request(
      `/screen/enter-password?state=${encodeURIComponent(state)}`,
      { method: "GET", headers: { Accept: "application/json" } },
      env,
    );
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      screen: { messages?: Array<{ text: string; type: string }> };
    };
    expect(json.screen.messages).toEqual([
      expect.objectContaining({
        type: "success",
        text: expect.stringContaining(RESET_BANNER),
      }),
    ]);
  });

  it("shows the confirmation once: submitting the password step clears it", async () => {
    const ctx = await setup();
    const { u2App, env, state } = ctx;

    await resetPasswordViaCode(ctx);
    const before = await env.data.loginSessions.get("tenantId", state);
    expect(readSessionNotice(before)).toBe("password_reset_success");

    const wrongPassword = await u2Screen(u2App, env, "enter-password").$post({
      query: { state },
      form: { password: "WrongP@ssw0rd!" },
    });
    expect(await wrongPassword.text()).not.toContain(RESET_BANNER);

    const after = await env.data.loginSessions.get("tenantId", state);
    expect(readSessionNotice(after)).toBeUndefined();
    const reloaded = await u2Screen(u2App, env, "enter-password").$get({
      query: { state },
    });
    expect(await reloaded.text()).not.toContain(RESET_BANNER);
  });

  it("drops the confirmation from the screen the widget gets back after a wrong password", async () => {
    const ctx = await setup();
    const { u2App, env, state } = ctx;

    await resetPasswordViaCode(ctx);

    // The widget submits as JSON. Its screen context is built from the login
    // session before the handler clears the notice, so the re-rendered screen
    // has to leave the confirmation out on its own.
    const response = await u2App.request(
      `/screen/enter-password?state=${encodeURIComponent(state)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: { password: "WrongP@ssw0rd!" } }),
      },
      env,
    );
    expect(response.status).toBe(400);
    const json = (await response.json()) as {
      screen: {
        messages?: unknown[];
        components: Array<{ id: string; messages?: unknown[] }>;
      };
    };
    expect(json.screen.messages ?? []).toEqual([]);
    const passwordField = json.screen.components.find(
      (c) => c.id === "password",
    );
    expect(passwordField?.messages).toHaveLength(1);
  });

  it("does not carry the confirmation to other screens", async () => {
    const ctx = await setup();
    const { u2App, env, state } = ctx;

    await resetPasswordViaCode(ctx);

    const identifier = await u2Screen(u2App, env, "login/identifier").$get({
      query: { state },
    });
    expect(await identifier.text()).not.toContain(RESET_BANNER);
  });

  it("does not show the confirmation without a reset", async () => {
    const { u2App, env, state } = await setup();

    const passwordStep = await u2Screen(u2App, env, "enter-password").$get({
      query: { state },
    });
    expect(await passwordStep.text()).not.toContain(RESET_BANNER);
  });
});

describe("session notice helper", () => {
  async function loginSessionFor() {
    const { env, state } = await setup();
    const loginSession = await env.data.loginSessions.get("tenantId", state);
    return { data: env.data, loginSession: loginSession! };
  }

  it("stores the notice and keeps the other state_data keys", async () => {
    const { data, loginSession } = await loginSessionFor();
    await data.loginSessions.update("tenantId", loginSession.id, {
      state_data: JSON.stringify({ hookId: "hook-1" }),
    });
    const withHook = (await data.loginSessions.get(
      "tenantId",
      loginSession.id,
    ))!;

    await setSessionNotice(
      data,
      "tenantId",
      withHook,
      "password_reset_success",
    );

    const stored = (await data.loginSessions.get("tenantId", loginSession.id))!;
    expect(JSON.parse(stored.state_data!)).toEqual({
      hookId: "hook-1",
      notice: "password_reset_success",
    });
    expect(readSessionNotice(stored)).toBe("password_reset_success");
  });

  it("clears only the notice and leaves the other keys", async () => {
    const { data, loginSession } = await loginSessionFor();
    await data.loginSessions.update("tenantId", loginSession.id, {
      state_data: JSON.stringify({
        hookId: "hook-1",
        notice: "password_reset_success",
      }),
    });
    const withNotice = (await data.loginSessions.get(
      "tenantId",
      loginSession.id,
    ))!;

    await clearSessionNotice(data, "tenantId", withNotice);

    const stored = (await data.loginSessions.get("tenantId", loginSession.id))!;
    expect(JSON.parse(stored.state_data!)).toEqual({ hookId: "hook-1" });
    expect(readSessionNotice(stored)).toBeUndefined();
  });

  it("empties state_data when the notice was all that was in it", async () => {
    const { data, loginSession } = await loginSessionFor();
    // /authorize stores session_cookie diagnostics; start from nothing.
    await data.loginSessions.update("tenantId", loginSession.id, {
      state_data: "",
    });
    await setSessionNotice(
      data,
      "tenantId",
      { ...loginSession, state_data: "" },
      "password_reset_success",
    );
    const withNotice = (await data.loginSessions.get(
      "tenantId",
      loginSession.id,
    ))!;

    await clearSessionNotice(data, "tenantId", withNotice);

    const stored = (await data.loginSessions.get("tenantId", loginSession.id))!;
    expect(stored.state_data ?? "").toBe("");
  });

  it("ignores unknown values and malformed state_data", async () => {
    const { loginSession } = await loginSessionFor();

    expect(
      readSessionNotice({
        ...loginSession,
        state_data: JSON.stringify({ notice: "something_else" }),
      }),
    ).toBeUndefined();
    expect(
      readSessionNotice({ ...loginSession, state_data: "not json" }),
    ).toBeUndefined();
    expect(readSessionNotice(undefined)).toBeUndefined();
  });
});

describe("password reset request ownership", () => {
  async function requestCode(ctx: Setup, state = ctx.state) {
    await u2Screen(ctx.u2App, ctx.env, "reset-password/request").$post({
      query: { state },
      form: { email: EMAIL },
    });
    const emails = ctx.getSentEmails();
    return emails[emails.length - 1].data.code!;
  }
  function submitCode(
    ctx: Setup,
    code: string,
    state = ctx.state,
    password = NEW_PASSWORD,
  ) {
    return u2Screen(ctx.u2App, ctx.env, "reset-password/code").$post({
      query: { state },
      form: { code, password, confirm_password: password },
    });
  }

  it.each([
    { transport: "u2", failure: "throw" },
    { transport: "legacy", failure: "throw" },
    { transport: "u2", failure: "false" },
    { transport: "legacy", failure: "false" },
  ])(
    "reports a successful $transport reset when completion persistence returns $failure",
    async ({ transport, failure }) => {
      const ctx = await setup();
      let code: string;
      if (transport === "u2") {
        code = await requestCode(ctx);
      } else {
        await ctx.env.data.connections.update(
          "tenantId",
          Strategy.USERNAME_PASSWORD,
          {
            options: { attributes: { email: { verification_method: "link" } } },
          },
        );
        await u2Screen(ctx.u2App, ctx.env, "reset-password/request").$post({
          query: { state: ctx.state },
          form: { email: EMAIL },
        });
        const emails = ctx.getSentEmails();
        code = new URL(
          emails[emails.length - 1].data.passwordResetUrl!,
        ).searchParams.get("code")!;
      }
      const originalUpdate = ctx.env.data.loginSessions.update.bind(
        ctx.env.data.loginSessions,
      );
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(ctx.env.data.loginSessions, "update").mockImplementation(
        async (tenant, id, fields) => {
          if (
            fields.state_data &&
            JSON.parse(fields.state_data).passwordReset?.state === "completed"
          ) {
            if (failure === "false") return false;
            throw new Error("completion store unavailable");
          }
          return originalUpdate(tenant, id, fields);
        },
      );
      const response =
        transport === "u2"
          ? await submitCode(ctx, code)
          : await ctx.universalApp.request(
              `/reset-password?${new URLSearchParams({ state: ctx.state, code })}`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                },
                body: new URLSearchParams({
                  password: NEW_PASSWORD,
                  "re-enter-password": NEW_PASSWORD,
                }),
              },
              ctx.env,
            );
      expect(response.status).toBe(transport === "u2" ? 302 : 200);
      expect(
        await bcryptjs.compare(
          NEW_PASSWORD,
          (await ctx.env.data.passwords.get("tenantId", USER_ID))!.password,
        ),
      ).toBe(true);
      expect(
        (await ctx.env.data.codes.get("tenantId", code, "password_reset"))
          ?.used_at,
      ).toBeTruthy();
      expect(warning).toHaveBeenCalledWith(
        "Failed to record password reset completion",
        expect.objectContaining({ loginSessionId: ctx.state }),
      );
      const { logs } = await ctx.env.data.logs.list("tenantId");
      expect(
        logs.some((log) => log.type === LogTypes.SUCCESS_CHANGE_PASSWORD),
      ).toBe(true);
      expect(
        logs.some((log) => log.type === LogTypes.FAILED_CHANGE_PASSWORD),
      ).toBe(false);
    },
  );

  it("rejects completion without a machine-recorded request", async () => {
    const ctx = await setup();
    await ctx.env.data.loginSessions.update("tenantId", ctx.state, {
      authParams: {
        ...(await ctx.env.data.loginSessions.get("tenantId", ctx.state))!
          .authParams,
        username: EMAIL,
      },
    });
    await ctx.env.data.codes.create("tenantId", {
      code_id: "123456",
      code_type: "password_reset",
      login_id: ctx.state,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
    expect((await submitCode(ctx, "123456")).status).toBe(400);
    expect(
      (await ctx.env.data.codes.get("tenantId", "123456", "password_reset"))
        ?.used_at,
    ).toBeUndefined();
    expect(
      await bcryptjs.compare(
        OLD_PASSWORD,
        (await ctx.env.data.passwords.get("tenantId", USER_ID))!.password,
      ),
    ).toBe(true);
  });

  it("requires a request before showing the code step", async () => {
    const ctx = await setup();
    const before = await u2Screen(
      ctx.u2App,
      ctx.env,
      "reset-password/code",
    ).$get({ query: { state: ctx.state } });
    expect(before.status).toBe(302);
    expect(locationPath(before).pathname).toMatch(/reset-password\/request$/);
    await requestCode(ctx);
    expect(
      (
        await u2Screen(ctx.u2App, ctx.env, "reset-password/code").$get({
          query: { state: ctx.state },
        })
      ).status,
    ).toBe(200);
  });

  it("keeps the same code-screen flow for an unknown account when signup is disabled", async () => {
    const ctx = await setup();
    await ctx.env.data.connections.update(
      "tenantId",
      Strategy.USERNAME_PASSWORD,
      { options: { disable_signup: true } },
    );
    const response = await u2Screen(
      ctx.u2App,
      ctx.env,
      "reset-password/request",
    ).$post({
      query: { state: ctx.state },
      form: { email: "unknown@example.com" },
    });
    expect(response.status).toBe(200);
    expect(ctx.getSentEmails()).toHaveLength(0);
    const reloaded = await u2Screen(
      ctx.u2App,
      ctx.env,
      "reset-password/code",
    ).$get({ query: { state: ctx.state } });
    expect(reloaded.status).toBe(200);
  });

  it("does not consume a code belonging to another login session", async () => {
    const ctx = await setup();
    const code = await requestCode(ctx);
    const session = (await ctx.env.data.loginSessions.get(
      "tenantId",
      ctx.state,
    ))!;
    const second = await ctx.env.data.loginSessions.create("tenantId", {
      authParams: session.authParams,
      csrf_token: "csrf",
      expires_at: session.expires_at,
    });
    await requestCode(ctx, second.id);
    expect((await submitCode(ctx, code, second.id)).status).toBe(400);
    expect(
      (await ctx.env.data.codes.get("tenantId", code, "password_reset"))
        ?.used_at,
    ).toBeUndefined();
    expect((await submitCode(ctx, code)).status).toBe(302);
  });

  it("invalidates the previous request when a new code is requested", async () => {
    const ctx = await setup();
    const oldCode = await requestCode(ctx);
    const newCode = await requestCode(ctx);
    expect((await submitCode(ctx, oldCode)).status).toBe(400);
    expect((await submitCode(ctx, newCode)).status).toBe(302);
    expect((await submitCode(ctx, newCode)).status).toBe(400);
  });

  it("keeps the request available after validation failure", async () => {
    const ctx = await setup();
    const code = await requestCode(ctx);
    expect((await submitCode(ctx, code, ctx.state, "")).status).toBe(400);
    expect(
      (await ctx.env.data.codes.get("tenantId", code, "password_reset"))
        ?.used_at,
    ).toBeUndefined();
    expect((await submitCode(ctx, code)).status).toBe(302);
  });

  it("resets the requested account even if the login identifier changes", async () => {
    const ctx = await setup();
    const code = await requestCode(ctx);
    const session = (await ctx.env.data.loginSessions.get(
      "tenantId",
      ctx.state,
    ))!;
    await ctx.env.data.loginSessions.update("tenantId", ctx.state, {
      authParams: { ...session.authParams, username: "another@example.com" },
    });
    expect((await submitCode(ctx, code)).status).toBe(302);
    expect(
      await bcryptjs.compare(
        NEW_PASSWORD,
        (await ctx.env.data.passwords.get("tenantId", USER_ID))!.password,
      ),
    ).toBe(true);
    expect(
      (await ctx.env.data.loginSessions.get("tenantId", ctx.state))!.authParams
        .username,
    ).toBe(EMAIL);
  });

  it.each([false, true])(
    "completes an emailed-link request through %s JSON transport",
    async (json) => {
      const ctx = await setup();
      await ctx.env.data.connections.update(
        "tenantId",
        Strategy.USERNAME_PASSWORD,
        { options: { attributes: { email: { verification_method: "link" } } } },
      );
      await u2Screen(ctx.u2App, ctx.env, "reset-password/request").$post({
        query: { state: ctx.state },
        form: { email: EMAIL },
      });
      const emails = ctx.getSentEmails();
      const url = new URL(emails[emails.length - 1].data.passwordResetUrl!);
      const code = url.searchParams.get("code")!;
      const query = { state: ctx.state, code };
      const get = json
        ? await ctx.u2App.request(
            `/screen/reset-password?${new URLSearchParams(query)}`,
            {},
            ctx.env,
          )
        : await u2Screen(ctx.u2App, ctx.env, "reset-password").$get({ query });
      expect(get.status).toBe(200);
      const body = await get.text();
      expect(body).toContain(`code=${code}`);
      // A link credential cannot be submitted through the code flow.
      expect((await submitCode(ctx, code)).status).toBe(400);
      const mismatch = json
        ? await ctx.u2App.request(
            `/screen/reset-password?${new URLSearchParams(query)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                data: { password: NEW_PASSWORD, confirm_password: "mismatch" },
              }),
            },
            ctx.env,
          )
        : await u2Screen(ctx.u2App, ctx.env, "reset-password").$post({
            query,
            form: { password: NEW_PASSWORD, confirm_password: "mismatch" },
          });
      expect(mismatch.status).toBe(400);
      expect(await mismatch.text()).toContain(`code=${code}`);
      const result = json
        ? await ctx.u2App.request(
            `/screen/reset-password?${new URLSearchParams(query)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                data: {
                  password: NEW_PASSWORD,
                  confirm_password: NEW_PASSWORD,
                },
              }),
            },
            ctx.env,
          )
        : await u2Screen(ctx.u2App, ctx.env, "reset-password").$post({
            query,
            form: { password: NEW_PASSWORD, confirm_password: NEW_PASSWORD },
          });
      expect(result.status).toBe(json ? 200 : 302);
      expect(
        await bcryptjs.compare(
          NEW_PASSWORD,
          (await ctx.env.data.passwords.get("tenantId", USER_ID))!.password,
        ),
      ).toBe(true);
    },
  );
});
