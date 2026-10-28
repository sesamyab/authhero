import type { Context } from "hono";
import { parse, serialize } from "cookie";
import { encodeHex, GrantType } from "@authhero/adapter-interfaces";
import type { DataAdapters, LoginSession } from "@authhero/adapter-interfaces";
import type { Bindings, Variables } from "../types";
import type { EnrichedClient } from "./client";
import { JSONHTTPException } from "../errors/json-http-exception";
import { safeCompare } from "../utils/safe-compare";
import { readLoginSessionData } from "../state-machines/login-session-data";

export type DeviceContext = Context<{
  Bindings: Bindings;
  Variables: Variables;
}>;
export const DEVICE_CODE_LIFETIME = 600;
export const DEVICE_POLL_INTERVAL = 5;
export async function hashDeviceCode(value: string): Promise<string> {
  return encodeHex(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}
export function normalizeUserCode(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}
export function requireDeviceCodes(data: DataAdapters) {
  if (!data.deviceCodes)
    throw new JSONHTTPException(503, {
      error: "temporarily_unavailable",
      error_description: "Device authorization storage is not configured",
    });
  return data.deviceCodes;
}
export function assertDeviceGrantAllowed(client: EnrichedClient) {
  if (
    !client.grant_types?.some(
      (g) => g === GrantType.DeviceCode || g === "device_code",
    )
  ) {
    throw new JSONHTTPException(400, {
      error: "unauthorized_client",
      error_description: "Device authorization is not enabled for this client",
    });
  }
}
export function authenticateDeviceClient(
  ctx: DeviceContext,
  client: EnrichedClient,
  secret?: string,
  basic = false,
) {
  const method =
    client.token_endpoint_auth_method ??
    (client.app_type === "native" || client.app_type === "spa"
      ? "none"
      : "client_secret_post");
  if (ctx.var.client_authenticated_via_assertion) return;
  if (method === "none" && secret === undefined) return;
  if (
    ((method === "client_secret_basic" && basic) ||
      (method === "client_secret_post" && !basic)) &&
    secret &&
    safeCompare(client.client_secret, secret)
  )
    return;
  throw new JSONHTTPException(401, {
    error: "invalid_client",
    error_description: "Client authentication failed",
  });
}

/** Fixed windows are persisted, so limits survive isolate restarts and work without a rate-limit binding. */
export async function limitDeviceRequests(
  ctx: DeviceContext,
  tenantId: string,
  purpose: string,
  limit: number,
  identity = ctx.var.ip || "unknown",
) {
  const windowMs = 5 * 60 * 1000;
  const window = Math.floor(Date.now() / windowMs);
  const key = `${purpose}:${await hashDeviceCode(identity)}:${window}`;
  const count = await requireDeviceCodes(ctx.env.data).incrementAttempts(
    tenantId,
    key,
    new Date((window + 1) * windowMs).toISOString(),
  );
  if (count > limit)
    throw new JSONHTTPException(429, {
      error: "slow_down",
      error_description:
        "Too many device authorization attempts. Try again later.",
    });
}
export function deviceFlowData(session: LoginSession) {
  return readLoginSessionData(session.state_data).deviceFlow;
}
export function isDeviceLoginSession(raw?: string | null) {
  return Boolean(readLoginSessionData(raw).deviceFlow?.deviceCodeHash);
}
function cookieName(state: string) {
  return `__Host-authhero_device_${state}`;
}
export function deviceBrowserCookie(session: LoginSession) {
  return serialize(cookieName(session.id), session.csrf_token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: DEVICE_CODE_LIFETIME,
  });
}
export function assertDeviceBrowser(ctx: DeviceContext, session: LoginSession) {
  const value = parse(ctx.req.header("cookie") || "")[cookieName(session.id)];
  if (!value || !safeCompare(session.csrf_token, value))
    throw new JSONHTTPException(403, {
      error: "access_denied",
      error_description: "Start device activation again in this browser",
    });
}
