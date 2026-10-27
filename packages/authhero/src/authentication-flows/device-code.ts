import { getIssuer } from "../variables";
import { z } from "@hono/zod-openapi";
import { LogTypes, LoginSessionState } from "@authhero/adapter-interfaces";
import { JSONHTTPException } from "../errors/json-http-exception";
import { createRefreshToken } from "./common";
import { logMessage } from "../helpers/logging";
import { resolvePrimaryUser } from "../helpers/users";
import {
  assertDeviceGrantAllowed,
  authenticateDeviceClient,
  deviceFlowData,
  hashDeviceCode,
  requireDeviceCodes,
  type DeviceContext,
} from "../helpers/device-flow";
import type { EnrichedClient } from "../helpers/client";
import type { GrantFlowUserResult } from "../types/GrantFlowResult";

export const deviceCodeGrantParamsSchema = z.object({
  grant_type: z.literal("urn:ietf:params:oauth:grant-type:device_code"),
  device_code: z.string().min(1).max(256),
  client_id: z.string(),
  client_secret: z.string().optional(),
});
export async function deviceCodeGrant(
  ctx: DeviceContext,
  params: z.infer<typeof deviceCodeGrantParamsSchema>,
  client: EnrichedClient,
): Promise<GrantFlowUserResult> {
  assertDeviceGrantAllowed(client);
  authenticateDeviceClient(
    ctx,
    client,
    params.client_secret,
    /^basic /i.test(ctx.req.header("Authorization") || ""),
  );
  const store = requireDeviceCodes(ctx.env.data);
  const hash = await hashDeviceCode(params.device_code);
  const fail = async (error: string, description: string): Promise<never> => {
    await logMessage(ctx, client.tenant.id, {
      type: LogTypes.FAILED_EXCHANGE_DEVICE_CODE_FOR_ACCESS_TOKEN,
      description,
    });
    throw new JSONHTTPException(400, { error, error_description: description });
  };
  // CAS serializes poll timestamps, slowdown increments and single-use redemption.
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = await store.get(client.tenant.id, hash);
    if (
      !code ||
      code.client_id !== client.client_id ||
      code.status === "consumed"
    )
      return fail("invalid_grant", "Invalid device code");
    if (Date.parse(code.expires_at) <= Date.now())
      return fail("expired_token", "Device code expired");
    if (code.status === "denied")
      return fail("access_denied", "The user denied this request");
    const now = new Date();
    const tooFast =
      code.last_polled_at !== undefined &&
      now.getTime() - Date.parse(code.last_polled_at) < code.interval * 1000;
    if (tooFast || code.status === "pending") {
      const updated = await store.update(client.tenant.id, hash, code.version, {
        last_polled_at: now.toISOString(),
        interval: code.interval + (tooFast ? 5 : 0),
      });
      if (!updated) continue;
      throw new JSONHTTPException(400, {
        error: tooFast ? "slow_down" : "authorization_pending",
        error_description: tooFast
          ? "Increase the polling interval by 5 seconds"
          : "The user has not approved this request",
      });
    }
    const login = code.login_id
      ? await ctx.env.data.loginSessions.get(client.tenant.id, code.login_id)
      : null;
    if (
      !login ||
      login.state !== LoginSessionState.AUTHENTICATED ||
      !login.user_id ||
      !login.session_id ||
      !deviceFlowData(login)?.ready ||
      deviceFlowData(login)?.deviceCodeHash !== hash
    )
      return fail("invalid_grant", "Invalid approval session");
    const session = await ctx.env.data.sessions.get(
      client.tenant.id,
      login.session_id,
    );
    if (
      !session ||
      session.revoked_at ||
      session.user_id !== login.user_id ||
      (session.expires_at !== undefined &&
        Date.parse(session.expires_at) <= Date.now())
    )
      return fail("invalid_grant", "Approval session is no longer valid");
    const codeUser = await ctx.env.data.users.get(
      client.tenant.id,
      login.user_id,
    );
    if (!codeUser) return fail("invalid_grant", "User no longer exists");
    const user = await resolvePrimaryUser(
      ctx.env.data.users,
      client.tenant.id,
      codeUser,
    );
    if (user.linked_to || user.blocked)
      return fail("access_denied", "User cannot sign in");
    if (
      !(await store.update(client.tenant.id, hash, code.version, {
        status: "consumed",
        last_polled_at: now.toISOString(),
      }))
    )
      continue;
    const audience =
      code.audience ??
      client.tenant.default_audience ??
      `${getIssuer(ctx.env, ctx.var.custom_domain)}userinfo`;
    let refresh_token: string | undefined;
    if (code.scope?.split(/\s+/).includes("offline_access")) {
      const refresh = await createRefreshToken(ctx, {
        user,
        client,
        login_id: login.id,
        session_id: login.session_id,
        scope: code.scope,
        audience,
        auth_connection: login.auth_connection,
        auth_strategy: login.auth_strategy,
      });
      refresh_token = refresh.wireToken;
    }
    await ctx.env.data.loginSessions.update(client.tenant.id, login.id, {
      state: LoginSessionState.COMPLETED,
    });
    return {
      user,
      client,
      loginSession: login,
      session_id: login.session_id,
      refresh_token,
      authConnection: login.auth_connection,
      authParams: {
        client_id: client.client_id,
        scope: code.scope,
        audience,
      },
    };
  }
  throw new JSONHTTPException(503, {
    error: "temporarily_unavailable",
    error_description: "Please retry the device token request",
  });
}
