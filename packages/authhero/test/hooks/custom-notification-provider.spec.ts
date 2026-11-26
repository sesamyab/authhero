import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { testClient } from "hono/testing";
import {
  ActionExecutionInsert,
  AuditEventInsert,
  AuthorizationResponseType,
  CodeExecutor,
  LoginSessionState,
  LogTypes,
  Strategy,
} from "@authhero/adapter-interfaces";
import { LocalCodeExecutor } from "../../src/hooks/code-executor/local";
import {
  DeliverNotificationParams,
  deliverNotification,
  NotificationDeliveryError,
  createNotificationScrubber,
  htmlToText,
  redactNotificationSecrets,
} from "../../src/hooks/custom-notification-provider";
import { flushBackgroundPromises } from "../../src/helpers/wait-until";
import { Bindings, Variables } from "../../src/types";
import { getTestServer } from "../helpers/test-server";
import { getAdminToken } from "../helpers/token";

const TENANT = "tenantId";
const EMAIL = "user@example.com";
const PHONE = "+46707123456";

type NotificationTriggerId = "custom-email-provider" | "custom-phone-provider";

type SetupOptions = {
  outbox?: boolean;
  /** Replaces the local executor, e.g. to simulate a timeout. */
  executor?: CodeExecutor;
};

async function setup(options: SetupOptions = {}) {
  const received: Array<{ triggerId: string; event: Record<string, unknown> }> =
    [];
  const executions: ActionExecutionInsert[] = [];
  const outboxEvents: AuditEventInsert[] = [];
  const codes: string[] = [];
  const local = new LocalCodeExecutor();
  const recording: CodeExecutor = {
    execute: async (params) => {
      received.push({ triggerId: params.triggerId, event: params.event });
      return (options.executor ?? local).execute(params);
    },
  };

  const server = await getTestServer({
    testTenantLanguage: "en",
    codeExecutor: recording,
    outbox: options.outbox,
    wrapDataAdapter: (data) => ({
      ...data,
      actionExecutions: {
        ...data.actionExecutions,
        create: async (tenant, execution) => {
          executions.push(execution);
          return data.actionExecutions.create(tenant, execution);
        },
      },
      codes: {
        ...data.codes,
        create: async (tenant, code) => {
          codes.push(code.code_id);
          if (code.otp) codes.push(code.otp);
          return data.codes.create(tenant, code);
        },
      },
      ...(data.outbox
        ? {
            outbox: {
              ...data.outbox,
              create: async (tenant: string, event: AuditEventInsert) => {
                outboxEvents.push(event);
                return data.outbox!.create(tenant, event);
              },
            },
          }
        : {}),
    }),
  });
  const { env } = server;

  let bound = 0;
  async function bind(
    trigger: NotificationTriggerId,
    body: string,
    metadata?: Record<string, unknown>,
  ) {
    const fn =
      trigger === "custom-email-provider"
        ? "onExecuteCustomEmailProvider"
        : "onExecuteCustomPhoneProvider";
    const action = await env.data.actions.create(TENANT, {
      name: `${trigger}-${bound++}`,
      supported_triggers: [{ id: trigger }],
      code: `exports.${fn} = async (event, api) => { ${body} };`,
    });
    await env.data.hooks.create(TENANT, {
      code_id: action.id,
      trigger_id: trigger,
      enabled: true,
      synchronous: false,
      metadata,
    });
  }

  const oauthClient = testClient(server.oauthApp, env);
  const startPasswordless = (
    connection: "email" | "sms",
    send: "code" | "link" = "code",
  ) =>
    oauthClient.passwordless.start.$post(
      {
        json:
          connection === "email"
            ? {
                client_id: "clientId",
                connection: "email",
                email: EMAIL,
                send,
                authParams: { redirect_uri: "https://example.com/callback" },
              }
            : {
                client_id: "clientId",
                connection: "sms",
                phone_number: PHONE,
                send,
                authParams: { redirect_uri: "https://example.com/callback" },
              },
      },
      { headers: { "x-real-ip": "1.2.3.4", "user-agent": "Mozilla/5.0" } },
    );

  async function addSmsConnection() {
    const token = await getAdminToken();
    const managementClient = testClient(server.managementApp, env);
    await managementClient.connections.$post(
      {
        header: { "tenant-id": TENANT },
        json: {
          name: "sms",
          strategy: Strategy.SMS,
          options: {
            provider: "twilio",
            from: "+1234567890",
            twilio_sid: "mock_account_sid",
            twilio_token: "mock_auth_token",
          },
        },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
  }

  async function logs() {
    const result = await env.data.logs.list(TENANT, {
      page: 0,
      per_page: 100,
      include_totals: false,
    });
    return result.logs;
  }

  const notifications = (trigger: NotificationTriggerId) =>
    received
      .filter((r) => r.triggerId === trigger)
      .map((r) => r.event.notification);

  return {
    server,
    env,
    bind,
    startPasswordless,
    addSmsConnection,
    logs,
    notifications,
    executions,
    outboxEvents,
    codes,
  };
}

describe("custom-email-provider trigger", () => {
  it("sends through the provider when no action is bound", async () => {
    const t = await setup();
    const response = await t.startPasswordless("email");
    expect(response.status).toBe(200);
    expect(t.server.getSentEmails()).toHaveLength(1);
    expect(t.notifications("custom-email-provider")).toHaveLength(0);
  });

  it("hands the rendered message to the action instead of the provider", async () => {
    const t = await setup();
    await t.bind("custom-email-provider", "/* delivered by my own system */");

    const response = await t.startPasswordless("email");
    expect(response.status).toBe(200);
    expect(t.server.getSentEmails()).toHaveLength(0);

    const [notification] = t.notifications("custom-email-provider");
    expect(notification).toMatchObject({
      message_type: "verification_code",
      to: EMAIL,
      locale: "en",
    });
    const code = t.codes[0]!;
    expect(notification).toHaveProperty("html", expect.stringContaining(code));
    expect(notification).toHaveProperty("text", expect.stringContaining(code));
    expect(notification).toHaveProperty("subject", expect.any(String));
    expect(notification).toHaveProperty("from", expect.any(String));

    // Logged like a normal send, and the run is recorded.
    const logs = await t.logs();
    expect(logs.some((l) => l.type === LogTypes.CODE_LINK_SENT)).toBe(true);
    expect(t.executions).toHaveLength(1);
    expect(t.executions[0]).toMatchObject({
      trigger_id: "custom-email-provider",
      status: "final",
    });
  });

  it("only handles the message types listed in the hook metadata", async () => {
    const t = await setup();
    await t.bind("custom-email-provider", "", {
      message_types: ["reset_email"],
    });

    expect((await t.startPasswordless("email")).status).toBe(200);
    expect(t.server.getSentEmails()).toHaveLength(1);
    expect(t.notifications("custom-email-provider")).toHaveLength(0);
  });

  it("handles a listed message type", async () => {
    const t = await setup();
    await t.bind("custom-email-provider", "", {
      message_types: ["verification_code"],
    });

    expect((await t.startPasswordless("email")).status).toBe(200);
    expect(t.server.getSentEmails()).toHaveLength(0);
    expect(t.notifications("custom-email-provider")).toHaveLength(1);
  });

  it("api.notification.useDefaultProvider() hands the message back to the provider", async () => {
    const t = await setup();
    await t.bind(
      "custom-email-provider",
      "api.notification.useDefaultProvider();",
    );

    expect((await t.startPasswordless("email")).status).toBe(200);
    expect(t.server.getSentEmails()).toHaveLength(1);
  });

  it("the last notification call wins", async () => {
    const t = await setup();
    await t.bind(
      "custom-email-provider",
      `api.notification.drop("no"); api.notification.useDefaultProvider();`,
    );

    expect((await t.startPasswordless("email")).status).toBe(200);
    expect(t.server.getSentEmails()).toHaveLength(1);
  });

  it("drop() fails the send with fn and does not fall back to the provider", async () => {
    const t = await setup();
    await t.bind(
      "custom-email-provider",
      `api.notification.drop("Recipient unsubscribed");`,
    );

    const response = await t.startPasswordless("email");
    expect(response.status).toBe(500);
    expect(t.server.getSentEmails()).toHaveLength(0);

    const failed = (await t.logs()).find(
      (l) => l.type === LogTypes.FAILED_SENDING_NOTIFICATION,
    );
    expect(failed?.description).toContain("dropped");
    expect(failed?.details).toMatchObject({
      trigger_id: "custom-email-provider",
      message_type: "verification_code",
      reason: "Recipient unsubscribed",
    });
  });

  it("an action that throws fails the send and never falls back silently", async () => {
    const t = await setup();
    await t.bind("custom-email-provider", `throw new Error("smtp down");`);

    const response = await t.startPasswordless("email");
    expect(response.status).toBe(500);
    expect(t.server.getSentEmails()).toHaveLength(0);
    const logs = await t.logs();
    expect(
      logs.some((l) => l.type === LogTypes.FAILED_SENDING_NOTIFICATION),
    ).toBe(true);
    expect(logs.some((l) => l.type === LogTypes.CODE_LINK_SENT)).toBe(false);
  });

  it("an action that times out fails the send", async () => {
    const t = await setup({
      executor: {
        execute: async () => ({
          success: false,
          error: "Action execution timed out after 5000ms",
          durationMs: 5000,
          apiCalls: [],
        }),
      },
    });
    await t.bind("custom-email-provider", "");

    expect((await t.startPasswordless("email")).status).toBe(500);
    expect(t.server.getSentEmails()).toHaveLength(0);
  });

  it("retry() accepts the message, logs wn and delivers on a background retry", async () => {
    const t = await setup();
    // Ask for a retry on the first run only; the background retry delivers.
    await t.bind(
      "custom-email-provider",
      `globalThis.__notificationRetryTest = (globalThis.__notificationRetryTest || 0) + 1;
       if (globalThis.__notificationRetryTest === 1) api.notification.retry("busy");`,
    );

    const response = await t.startPasswordless("email");
    expect(response.status).toBe(200);
    expect(t.notifications("custom-email-provider")).toHaveLength(2);
    expect(t.server.getSentEmails()).toHaveLength(0);
    const logs = await t.logs();
    expect(
      logs.filter((l) => l.type === LogTypes.WARNING_SENDING_NOTIFICATION),
    ).toHaveLength(1);
    expect(
      logs.some((l) => l.type === LogTypes.FAILED_SENDING_NOTIFICATION),
    ).toBe(false);
    Reflect.deleteProperty(globalThis, "__notificationRetryTest");
  });

  it("an email provider named custom requires an action", async () => {
    const t = await setup();
    await t.env.data.emailProviders.remove(TENANT);
    await t.env.data.emailProviders.create(TENANT, {
      name: "custom",
      enabled: true,
      credentials: {},
    });

    expect((await t.startPasswordless("email")).status).toBe(500);
    const failed = (await t.logs()).find(
      (l) => l.type === LogTypes.FAILED_SENDING_NOTIFICATION,
    );
    expect(failed?.description).toContain("no enabled custom-email-provider");

    await t.bind("custom-email-provider", "");
    expect((await t.startPasswordless("email")).status).toBe(200);
    expect(t.notifications("custom-email-provider")).toHaveLength(1);
  });
});

describe("custom-phone-provider trigger", () => {
  it("hands passwordless SMS codes to the action as otp_verify", async () => {
    const t = await setup();
    await t.addSmsConnection();
    await t.bind("custom-phone-provider", "");

    expect((await t.startPasswordless("sms")).status).toBe(200);
    expect(t.server.getSentSms()).toHaveLength(0);

    const [notification] = t.notifications("custom-phone-provider");
    const code = t.codes[0]!;
    expect(notification).toMatchObject({
      message_type: "otp_verify",
      recipient: PHONE,
      code,
      delivery_method: "text",
      as_text: expect.stringContaining(code),
      as_voice: expect.stringContaining(code),
    });
  });

  it("keeps using the SMS connection when no action is bound", async () => {
    const t = await setup();
    await t.addSmsConnection();

    expect((await t.startPasswordless("sms")).status).toBe(200);
    expect(t.server.getSentSms()).toHaveLength(1);
  });

  it("useDefaultProvider() sends through the SMS connection", async () => {
    const t = await setup();
    await t.addSmsConnection();
    await t.bind(
      "custom-phone-provider",
      `if (event.notification.message_type === "otp_verify") api.notification.useDefaultProvider();`,
    );

    expect((await t.startPasswordless("sms")).status).toBe(200);
    expect(t.server.getSentSms()).toHaveLength(1);
  });
});

describe("custom-phone-provider trigger for MFA SMS", () => {
  const USER_ID = "email|userId";

  async function mfaSetup() {
    const t = await setup();
    await t.env.data.tenants.update(TENANT, {
      mfa: {
        policy: "always",
        factors: {
          sms: true,
          otp: false,
          email: false,
          push_notification: false,
          webauthn_roaming: false,
          webauthn_platform: false,
          recovery_code: false,
          duo: false,
        },
      },
    });
    const loginSession = await t.env.data.loginSessions.create(TENANT, {
      expires_at: new Date(Date.now() + 600000).toISOString(),
      csrf_token: "csrfToken",
      authParams: {
        client_id: "clientId",
        redirect_uri: "https://example.com/callback",
        scope: "openid",
        response_type: AuthorizationResponseType.CODE,
        state: "state",
      },
      user_id: USER_ID,
      state: LoginSessionState.AWAITING_MFA,
    });
    const post = (path: string, data: Record<string, string>) =>
      t.server.u2App.request(
        `${path}?state=${encodeURIComponent(loginSession.id)}`,
        {
          method: "POST",
          headers: {
            "tenant-id": TENANT,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams(data).toString(),
        },
        t.env,
      );
    return { t, post };
  }

  it("sends enrollment codes as otp_enroll and challenge resends as otp_verify", async () => {
    const { t, post } = await mfaSetup();
    await t.bind("custom-phone-provider", "");

    const enroll = await post("/mfa/phone-enrollment", {
      phone_number: "+46 70 123 45 67",
    });
    expect(enroll.status).toBe(302);
    expect(enroll.headers.get("location")).toContain("/mfa/phone-challenge");

    const resend = await post("/mfa/phone-challenge", { action: "resend" });
    expect(resend.status).toBe(200);
    expect(await resend.text()).toContain("We sent a new code to your phone");

    expect(t.server.getSentSms()).toHaveLength(0);
    const sent = t.notifications("custom-phone-provider");
    expect(sent.map((n) => Reflect.get(Object(n), "message_type"))).toEqual([
      "otp_enroll",
      "otp_verify",
    ]);
    expect(sent[0]).toMatchObject({
      recipient: "+46701234567",
      code: expect.stringMatching(/^\d{6}$/),
    });
    const logs = await t.logs();
    expect(logs.filter((l) => l.type === LogTypes.MFA_SMS_SENT)).toHaveLength(
      2,
    );
  });

  it("shows the send error when the action drops the message", async () => {
    const { t, post } = await mfaSetup();
    await t.bind("custom-phone-provider", "");
    await post("/mfa/phone-enrollment", { phone_number: "+46 70 123 45 67" });

    await t.bind(
      "custom-phone-provider",
      `api.notification.drop("number blocked");`,
    );
    // Higher priority wins: rebind the dropping action above the first one.
    const { hooks } = await t.env.data.hooks.list(TENANT, {
      q: "trigger_id:custom-phone-provider",
    });
    const dropping = hooks.at(-1)!;
    await t.env.data.hooks.update(TENANT, dropping.hook_id, { priority: 10 });

    const resend = await post("/mfa/phone-challenge", { action: "resend" });
    expect(resend.status).toBe(200);
    const body = await resend.text();
    expect(body).toContain("There was a problem sending the SMS");
    expect(t.server.getSentSms()).toHaveLength(0);
    const logs = await t.logs();
    expect(logs.some((l) => l.type === LogTypes.ERROR_SENDING_MFA_SMS)).toBe(
      true,
    );
    expect(
      logs.some((l) => l.type === LogTypes.FAILED_SENDING_NOTIFICATION),
    ).toBe(true);
  });
});

describe("custom provider background retries", () => {
  async function deliver(
    t: Awaited<ReturnType<typeof setup>>,
    overrides: Partial<DeliverNotificationParams> = {},
  ) {
    let defaultSends = 0;
    let caught: unknown;
    const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
    app.get("/", async (ctx) => {
      ctx.set("tenant_id", TENANT);
      try {
        await deliverNotification(ctx, {
          trigger: "custom-email-provider",
          tenantId: TENANT,
          messageType: "verify_email",
          recipient: EMAIL,
          secrets: ["s3cret-link"],
          retryDelaysMs: [0, 0, 0, 0, 0],
          buildNotification: async () => ({
            message_type: "verify_email",
            to: EMAIL,
            from: "noreply@example.com",
            subject: "Verify",
            html: "<a href='s3cret-link'>verify</a>",
            text: "verify: s3cret-link",
            locale: "en",
          }),
          sendDefault: async () => {
            defaultSends++;
          },
          ...overrides,
        });
      } catch (error) {
        caught = error;
      }
      await flushBackgroundPromises(ctx);
      return ctx.text("ok");
    });
    await app.request("/", {}, t.env);
    return { defaultSends, caught };
  }

  it("gives up with fn after 5 retries", async () => {
    const t = await setup();
    await t.bind("custom-email-provider", `api.notification.retry("busy");`);

    const { caught, defaultSends } = await deliver(t);
    expect(caught).toBeUndefined();
    expect(defaultSends).toBe(0);
    // The first run plus five retries.
    expect(t.notifications("custom-email-provider")).toHaveLength(6);

    const logs = await t.logs();
    expect(
      logs.filter((l) => l.type === LogTypes.WARNING_SENDING_NOTIFICATION),
    ).toHaveLength(6);
    const failed = logs.filter(
      (l) => l.type === LogTypes.FAILED_SENDING_NOTIFICATION,
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.description).toContain("gave up after 5 retries");
  });

  it("a retry can hand the message to the default provider", async () => {
    const t = await setup();
    await t.bind(
      "custom-email-provider",
      `globalThis.__notificationFallbackTest = (globalThis.__notificationFallbackTest || 0) + 1;
       if (globalThis.__notificationFallbackTest === 1) api.notification.retry();
       else api.notification.useDefaultProvider();`,
    );

    const { defaultSends } = await deliver(t);
    expect(defaultSends).toBe(1);
    Reflect.deleteProperty(globalThis, "__notificationFallbackTest");
  });

  it("stops retrying once the message is no longer current", async () => {
    const t = await setup();
    await t.bind("custom-email-provider", `api.notification.retry("busy");`);
    let checks = 0;
    await deliver(t, {
      isCurrent: async () => {
        checks++;
        return checks < 2;
      },
    });
    // The first run, one retry, then the second check finds it stale.
    expect(t.notifications("custom-email-provider")).toHaveLength(2);
    const logs = await t.logs();
    expect(
      logs.some((l) => l.type === LogTypes.FAILED_SENDING_NOTIFICATION),
    ).toBe(false);
  });

  it("stops retrying (and logs fn) when the background budget runs out", async () => {
    const t = await setup();
    await t.bind("custom-email-provider", `api.notification.retry("busy");`);
    await deliver(t, { retryBudgetMs: 1000 });
    expect(t.notifications("custom-email-provider")).toHaveLength(1);
    const failed = (await t.logs()).filter(
      (l) => l.type === LogTypes.FAILED_SENDING_NOTIFICATION,
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.description).toContain("gave up after 0 retries");
  });

  it("logs fn when a retry hands off to a default provider that fails", async () => {
    const t = await setup();
    await t.bind(
      "custom-email-provider",
      `globalThis.__notificationHandoffTest = (globalThis.__notificationHandoffTest || 0) + 1;
       if (globalThis.__notificationHandoffTest === 1) api.notification.retry();
       else api.notification.useDefaultProvider();`,
    );
    const { caught } = await deliver(t, {
      sendDefault: async () => {
        throw new Error("smtp refused s3cret-link");
      },
    });
    expect(caught).toBeUndefined();
    const failed = (await t.logs()).filter(
      (l) => l.type === LogTypes.FAILED_SENDING_NOTIFICATION,
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.description).toContain("default provider, which failed");
    expect(JSON.stringify(failed[0])).not.toContain("s3cret-link");
    Reflect.deleteProperty(globalThis, "__notificationHandoffTest");
  });

  it("useDefaultProvider() is an error when the tenant has no default provider", async () => {
    const t = await setup();
    await t.bind(
      "custom-email-provider",
      "api.notification.useDefaultProvider();",
    );

    const { caught, defaultSends } = await deliver(t, { requireAction: true });
    expect(caught).toBeInstanceOf(NotificationDeliveryError);
    expect(defaultSends).toBe(0);
  });

  it("withholds values that carry a fragment of the message", () => {
    const scrub = createNotificationScrubber([
      "123456",
      "<p>Your login code is 123456. It expires in 30 minutes.</p>",
    ]);
    expect(scrub("sent code 123456")).toBe("sent code [REDACTED]");
    expect(scrub("echo: <p>Your login code is 1")).toBe(
      "[withheld: contains message content]",
    );
    expect(scrub("provider returned 503 Service Unavailable")).toBe(
      "provider returned 503 Service Unavailable",
    );
  });

  it("keeps links from single- and double-quoted hrefs in the plain text", () => {
    expect(
      htmlToText(
        `<p>Reset: <a href='https://a.example/r?code=1'>here</a> or <a href="https://b.example/v">there</a></p>`,
      ),
    ).toBe(
      "Reset: here (https://a.example/r?code=1) or there (https://b.example/v)",
    );
  });

  it("redacts secrets longest-first", () => {
    expect(
      redactNotificationSecrets("code 123456 in <p>code 123456</p>", [
        "123456",
        "<p>code 123456</p>",
      ]),
    ).toBe("code [REDACTED] in [REDACTED]");
    expect(redactNotificationSecrets("abc", ["ab"])).toBe("abc");
  });
});

describe("secrecy", () => {
  it("never writes the code or the message content to logs, the outbox, execution records or errors", async () => {
    const t = await setup({ outbox: true });
    await t.addSmsConnection();
    // The action echoes everything it was given into its console output,
    // its drop reason and its error.
    await t.bind(
      "custom-email-provider",
      `console.log(JSON.stringify(event.notification));
       api.notification.drop(event.notification.html + event.notification.text);`,
    );
    await t.bind(
      "custom-phone-provider",
      `console.log(event.notification.code, event.notification.as_text);
       throw new Error("could not deliver " + event.notification.code + " " + event.notification.as_text);`,
    );

    const responses = [
      await t.startPasswordless("email"),
      await t.startPasswordless("email", "link"),
      await t.startPasswordless("sms"),
    ];
    for (const response of responses) {
      expect(response.status).toBe(500);
    }
    const bodies = await Promise.all(responses.map((r) => r.text()));

    const emailNotifications = t.notifications("custom-email-provider");
    const phoneNotifications = t.notifications("custom-phone-provider");
    expect(emailNotifications).toHaveLength(2);
    expect(phoneNotifications).toHaveLength(1);

    const contents: string[] = [];
    for (const n of [...emailNotifications, ...phoneNotifications]) {
      if (n && typeof n === "object") {
        for (const key of ["html", "text", "as_text", "subject"]) {
          const value = Reflect.get(n, key);
          if (typeof value === "string" && value.length > 0) {
            contents.push(value);
          }
        }
      }
    }
    const secrets = [...t.codes, ...contents];
    expect(t.codes.length).toBeGreaterThanOrEqual(3);

    // Every string that was stored or returned.
    const stored: string[] = [];
    const collect = (value: unknown) => {
      if (typeof value === "string") stored.push(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === "object") {
        Object.values(value).forEach(collect);
      }
    };
    collect([await t.logs(), t.outboxEvents, t.executions, bodies]);
    expect(stored.length).toBeGreaterThan(10);

    const forms = (value: string) => [
      value,
      JSON.stringify(value).slice(1, -1),
    ];
    for (const secret of secrets) {
      for (const form of forms(secret)) {
        expect(stored.filter((s) => s.includes(form))).toEqual([]);
      }
    }
    // Not even a fragment of the rendered content survives: executors
    // truncate console lines, so an echoed message often survives only partly.
    for (const content of contents) {
      for (let at = 0; at + 40 <= content.length; at += 20) {
        for (const form of forms(content.slice(at, at + 40))) {
          const leaks = stored.filter((s) => s.includes(form));
          expect(leaks, `fragment at ${at}: ${form}`).toEqual([]);
        }
      }
    }

    // The failures are still visible to support.
    const logs = await t.logs();
    expect(
      logs.filter((l) => l.type === LogTypes.FAILED_SENDING_NOTIFICATION)
        .length,
    ).toBeGreaterThanOrEqual(3);
    expect(t.executions.length).toBe(3);
    const executionText = JSON.stringify(t.executions);
    expect(executionText).toMatch(/\[REDACTED\]|\[withheld/);
  });
});
