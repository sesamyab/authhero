import { nanoid } from "nanoid";
import {
  LoginSessionState,
  LogTypes,
  type FormNodeComponent,
} from "@authhero/adapter-interfaces";
import { createTranslation } from "../../../i18n";
import { JSONHTTPException } from "../../../errors/json-http-exception";
import { RedirectException } from "../../../errors/redirect-exception";
import {
  assertDeviceBrowser,
  assertDeviceGrantAllowed,
  deviceBrowserCookie,
  deviceFlowData,
  hashDeviceCode,
  limitDeviceRequests,
  normalizeUserCode,
  requireDeviceCodes,
} from "../../../helpers/device-flow";
import { createLoginSessionWithData } from "../../../state-machines/login-session-data";
import { logMessage } from "../../../helpers/logging";
import { getEnrichedClient } from "../../../helpers/client";
import { escapeHtml } from "../sanitization-utils";
import {
  getLoginPath,
  type ScreenContext,
  type ScreenDefinition,
  type ScreenResult,
} from "./types";

const translation = (c: ScreenContext) =>
  createTranslation(
    "device-flow",
    "device-flow",
    c.language || "en",
    c.customText,
  ).m;
async function getLogin(c: ScreenContext) {
  c.ctx.header("Cache-Control", "no-store");
  const login = await c.ctx.env.data.loginSessions.get(c.tenant.id, c.state);
  if (
    !login ||
    !deviceFlowData(login) ||
    Date.parse(login.expires_at) <= Date.now()
  )
    throw new JSONHTTPException(400, {
      error: "expired_token",
      error_description: translation(c).sessionExpired(),
    });
  assertDeviceBrowser(c.ctx, login);
  return login;
}
const submitButton = (text: string, order: number): FormNodeComponent => ({
  id: "submit",
  type: "NEXT_BUTTON",
  category: "BLOCK",
  visible: true,
  config: { text },
  order,
});

async function codeScreen(c: ScreenContext): Promise<ScreenResult> {
  const login = await getLogin(c);
  const m = translation(c);
  return {
    branding: c.branding,
    screen: {
      name: "device-code",
      title: m.title(),
      description: m.description(),
      action: `/u2/device/code?state=${encodeURIComponent(c.state)}`,
      method: "POST",
      messages: c.messages,
      components: [
        {
          id: "user_code",
          type: "TEXT",
          category: "FIELD",
          visible: true,
          label: m.codeLabel(),
          required: true,
          config: {
            placeholder: m.codePlaceholder(),
            max_length: 32,
            default_value: deviceFlowData(login)?.userCode,
          },
        },
        submitButton(m.buttonText(), 1),
      ],
    },
  };
}
async function submitCode(c: ScreenContext, data: Record<string, unknown>) {
  const login = await getLogin(c);
  const m = translation(c);
  // A per-browser cap complements the shared per-IP window.
  await limitDeviceRequests(c.ctx, c.tenant.id, "entry-session", 5, login.id);
  await limitDeviceRequests(c.ctx, c.tenant.id, "entry-ip", 10);
  const userCode =
    typeof data.user_code === "string" ? normalizeUserCode(data.user_code) : "";
  const code = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/.test(userCode)
    ? await requireDeviceCodes(c.ctx.env.data).getByUserCode(
        c.tenant.id,
        await hashDeviceCode(userCode),
      )
    : null;
  if (
    !code ||
    code.status !== "pending" ||
    Date.parse(code.expires_at) <= Date.now()
  ) {
    await logMessage(c.ctx, c.tenant.id, {
      type: LogTypes.FAILED_DEVICE_ACTIVATION,
      description: "Invalid or expired user code",
    });
    return { error: m["invalid-code"](), screen: await codeScreen(c) };
  }
  const client = await getEnrichedClient(
    c.ctx.env,
    code.client_id,
    c.tenant.id,
  );
  assertDeviceGrantAllowed(client);
  // Fresh state per browser attempt. The device never sees a login-session
  // id or the browser CSRF secret in its polling response.
  const activated = await createLoginSessionWithData(
    c.ctx.env.data.loginSessions,
    c.tenant.id,
    {
      csrf_token: nanoid(32),
      expires_at: code.expires_at,
      authParams: {
        client_id: code.client_id,
        scope: code.scope,
        audience: code.audience,
      },
      ip: c.ctx.var.ip,
      useragent: c.ctx.var.useragent,
    },
    {
      deviceFlow: {
        deviceCodeHash: code.device_code_hash,
        userCode: `${userCode.slice(0, 4)}-${userCode.slice(4)}`,
      },
    },
  );
  return {
    redirect: `${await getLoginPath({ ...c, client, connections: client.connections, routePrefix: "/u2" })}?state=${encodeURIComponent(activated.id)}`,
    cookies: [deviceBrowserCookie(activated)],
  };
}
async function confirmation(c: ScreenContext) {
  const login = await getLogin(c);
  const flow = deviceFlowData(login);
  if (!flow?.deviceCodeHash)
    throw new JSONHTTPException(400, { error: "invalid_request" });
  if (
    login.state !== LoginSessionState.AUTHENTICATED ||
    !flow.ready ||
    !login.session_id ||
    !login.user_id
  ) {
    throw new RedirectException(
      `/authorize/resume?state=${encodeURIComponent(c.state)}`,
    );
  }
  const session = await c.ctx.env.data.sessions.get(
    c.tenant.id,
    login.session_id,
  );
  if (
    !session ||
    session.revoked_at ||
    session.user_id !== login.user_id ||
    (session.expires_at !== undefined &&
      Date.parse(session.expires_at) <= Date.now())
  )
    throw new JSONHTTPException(403, { error: "access_denied" });
  const code = await requireDeviceCodes(c.ctx.env.data).get(
    c.tenant.id,
    flow.deviceCodeHash,
  );
  if (
    !code ||
    code.client_id !== c.client.client_id ||
    Date.parse(code.expires_at) <= Date.now()
  )
    throw new JSONHTTPException(400, { error: "expired_token" });
  return { login, flow, code };
}
async function confirmationScreen(c: ScreenContext): Promise<ScreenResult> {
  const { flow, code } = await confirmation(c);
  const m = translation(c);
  if (code.status !== "pending")
    throw new JSONHTTPException(400, {
      error: "invalid_grant",
      error_description: m.alreadyCompleted(),
    });
  const scopes = code.scope?.split(/\s+/).filter(Boolean) || [];
  const content = `<p>${escapeHtml(m.requestDescription({ clientName: c.client.name || c.client.client_id }))}</p><p><strong>${escapeHtml(flow.userCode || "")}</strong></p>${code.audience ? `<p>${escapeHtml(m.audienceLabel())}: ${escapeHtml(code.audience)}</p>` : ""}${scopes.length ? `<p>${escapeHtml(m.scopesLabel())}</p><ul>${scopes.map((scope) => `<li>${escapeHtml(scope)}</li>`).join("")}</ul>` : ""}`;
  return {
    branding: c.branding,
    screen: {
      name: "device-confirmation",
      title: m.confirmTitle(),
      description: m.confirmDescription(),
      method: "POST",
      action: `/u2/device/confirmation?state=${encodeURIComponent(c.state)}`,
      components: [
        {
          id: "summary",
          type: "RICH_TEXT",
          category: "BLOCK",
          visible: true,
          config: { content },
          order: 0,
        },
        {
          id: "decision",
          type: "CHOICE",
          category: "FIELD",
          visible: true,
          label: m.decisionLabel(),
          required: true,
          config: {
            display: "radio",
            options: [
              { value: "approve", label: m.approveText() },
              { value: "deny", label: m.denyText() },
            ],
          },
          order: 1,
        },
        submitButton(m.buttonText(), 2),
      ],
    },
  };
}
async function submitConfirmation(
  c: ScreenContext,
  data: Record<string, unknown>,
) {
  const { code, login } = await confirmation(c);
  assertDeviceGrantAllowed(c.client);
  if (data.decision !== "approve" && data.decision !== "deny")
    return {
      error: translation(c).decisionLabel(),
      screen: await confirmationScreen(c),
    };
  const status = data.decision === "approve" ? "approved" : "denied";
  const store = requireDeviceCodes(c.ctx.env.data);
  let current = code;
  for (let attempt = 0; ; attempt++) {
    if (current.status !== "pending")
      throw new JSONHTTPException(409, {
        error: "invalid_grant",
        error_description: translation(c).alreadyCompleted(),
      });
    if (Date.parse(current.expires_at) <= Date.now())
      throw new JSONHTTPException(400, { error: "expired_token" });
    if (
      await store.update(
        c.tenant.id,
        current.device_code_hash,
        current.version,
        { status, login_id: login.id },
      )
    )
      break;
    if (attempt === 19)
      throw new JSONHTTPException(503, { error: "temporarily_unavailable" });
    // A poll may change the version without making a decision. Retry only
    // against fresh state; another browser's approval or denial is final.
    const latest = await store.get(c.tenant.id, current.device_code_hash);
    if (!latest) throw new JSONHTTPException(400, { error: "expired_token" });
    current = latest;
  }
  if (status === "denied") {
    await logMessage(c.ctx, c.tenant.id, {
      type: LogTypes.USER_CANCELED_DEVICE_CONFIRMATION,
      userId: login.user_id,
      description: "User denied device authorization",
    });
  }
  return {
    redirect: `/u2/device/complete?state=${encodeURIComponent(c.state)}`,
  };
}
async function completeScreen(c: ScreenContext): Promise<ScreenResult> {
  const login = await getLogin(c);
  const hash = deviceFlowData(login)?.deviceCodeHash;
  const code = hash
    ? await requireDeviceCodes(c.ctx.env.data).get(c.tenant.id, hash)
    : null;
  if (!code || code.login_id !== login.id || code.status === "pending")
    throw new JSONHTTPException(400, { error: "invalid_request" });
  const m = translation(c);
  return {
    branding: c.branding,
    screen: {
      name: "device-complete",
      action: `/u2/device/complete?state=${encodeURIComponent(c.state)}`,
      method: "GET",
      title: m.completeTitle(),
      description:
        code.status === "denied"
          ? m.deniedDescription()
          : m.approvedDescription(),
      components: [],
    },
  };
}
export const deviceCodeScreenDefinition: ScreenDefinition = {
  id: "device-code",
  name: "Device code",
  handler: { get: codeScreen, post: submitCode },
};
export const deviceConfirmationScreenDefinition: ScreenDefinition = {
  id: "device-confirmation",
  name: "Confirm device",
  handler: { get: confirmationScreen, post: submitConfirmation },
};
export const deviceCompleteScreenDefinition: ScreenDefinition = {
  id: "device-complete",
  name: "Device authorization complete",
  handler: { get: completeScreen },
};
