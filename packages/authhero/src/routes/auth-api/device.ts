import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { nanoid, customAlphabet } from "nanoid";
import QRCode from "qrcode";
import {
  encodeBase64,
  encodeBase64Url,
  LogTypes,
  type Client,
} from "@authhero/adapter-interfaces";
import { defineRoute } from "../../utils/define-route";
import { getEnrichedClient } from "../../helpers/client";
import { isCimdClientId } from "../../helpers/cimd";
import { parseBasicAuthHeader } from "../../utils/auth-header";
import { getAuthUrl } from "../../variables";
import { setTenantId } from "../../helpers/set-tenant-id";
import { logMessage } from "../../helpers/logging";
import { createLoginSessionWithData } from "../../state-machines/login-session-data";
import { JSONHTTPException } from "../../errors/json-http-exception";
import {
  assertDeviceGrantAllowed,
  authenticateDeviceClient,
  hashDeviceCode,
  limitDeviceRequests,
  requireDeviceCodes,
  deviceBrowserCookie,
  DEVICE_CODE_LIFETIME,
  DEVICE_POLL_INTERVAL,
} from "../../helpers/device-flow";
import type { Bindings, Variables } from "../../types";

const requestSchema = z.object({
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  scope: z.string().optional(),
  audience: z.string().optional(),
  include_qr_code: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .optional()
    .openapi({
      description:
        "Include a QR-code image encoding verification_uri_complete. Accepts a JSON boolean or a form string.",
    }),
});
const responseSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string().url(),
  verification_uri_complete: z.string().url(),
  qr_code: z.string().optional().openapi({
    description:
      "SVG image data URL encoding verification_uri_complete, present only when include_qr_code=true. Display it on the requesting device alongside the user code.",
  }),
  expires_in: z.number(),
  interval: z.number(),
});
const errorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});
const generateUserCode = customAlphabet("BCDFGHJKLMNPQRSTVWXZ", 8);
const postCode = defineRoute({
  route: createRoute({
    tags: ["oauth2"],
    method: "post",
    path: "/",
    request: {
      body: {
        content: {
          "application/x-www-form-urlencoded": { schema: requestSchema },
          "application/json": { schema: requestSchema },
        },
      },
    },
    responses: {
      200: {
        description: "Device authorization request",
        content: { "application/json": { schema: responseSchema } },
      },
      400: {
        description: "Invalid request",
        content: { "application/json": { schema: errorSchema } },
      },
      401: {
        description: "Invalid client",
        content: { "application/json": { schema: errorSchema } },
      },
      429: {
        description: "Rate limited",
        content: { "application/json": { schema: errorSchema } },
      },
    },
  }),
  handler: async (ctx) => {
    const body = ctx.req.header("content-type")?.includes("application/json")
      ? ctx.req.valid("json")
      : ctx.req.valid("form");
    const basic = parseBasicAuthHeader(ctx.req.header("Authorization"));
    if (
      basic.client_id &&
      (body.client_secret !== undefined ||
        (body.client_id && body.client_id !== basic.client_id))
    )
      throw new JSONHTTPException(400, {
        error: "invalid_request",
        error_description: "Use one client authentication method",
      });
    const params = { ...body, ...basic };
    if (!params.client_id)
      throw new JSONHTTPException(400, {
        error: "invalid_request",
        error_description: "client_id is required",
      });
    let client;
    try {
      client = await getEnrichedClient(
        ctx.env,
        params.client_id,
        ctx.var.tenant_id,
      );
    } catch {
      throw new JSONHTTPException(401, {
        error: "invalid_client",
        error_description: "Client not found",
      });
    }
    setTenantId(ctx, client.tenant.id);
    ctx.set("client_id", client.client_id);
    try {
      assertDeviceGrantAllowed(client);
      authenticateDeviceClient(
        ctx,
        client,
        params.client_secret,
        Boolean(basic.client_id),
      );
      await limitDeviceRequests(ctx, client.tenant.id, "issue", 30);
      if (params.audience) {
        const { resource_servers } = await ctx.env.data.resourceServers.list(
          client.tenant.id,
        );
        if (!resource_servers.some((rs) => rs.identifier === params.audience))
          throw new JSONHTTPException(400, {
            error: "invalid_target",
            error_description: "Unknown audience",
          });
      }
      const store = requireDeviceCodes(ctx.env.data);
      const device_code = encodeBase64Url(
        crypto.getRandomValues(new Uint8Array(32)),
      );
      const normalized = generateUserCode();
      const user_code = `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
      const now = new Date();
      await store.create(client.tenant.id, {
        device_code_hash: await hashDeviceCode(device_code),
        user_code_hash: await hashDeviceCode(normalized),
        client_id: client.client_id,
        scope: params.scope,
        audience: params.audience,
        status: "pending",
        interval: DEVICE_POLL_INTERVAL,
        version: 0,
        created_at: now.toISOString(),
        expires_at: new Date(
          now.getTime() + DEVICE_CODE_LIFETIME * 1000,
        ).toISOString(),
      });
      const verification = new URL(
        "activate",
        getAuthUrl(ctx.env, ctx.var.custom_domain),
      );
      // Shared-host deployments need the tenant hint. Host-derived tenants still win.
      if (!ctx.var.custom_domain)
        verification.searchParams.set("tenant_id", client.tenant.id);
      const verification_uri = verification.toString();
      verification.searchParams.set("user_code", user_code);
      const verification_uri_complete = verification.toString();
      let qr_code: string | undefined;
      if (
        params.include_qr_code === true ||
        params.include_qr_code === "true"
      ) {
        // SVG works on Workers as well as Node; no canvas or PNG stream APIs.
        const svg = await QRCode.toString(verification_uri_complete, {
          type: "svg",
          errorCorrectionLevel: "M",
          width: 256,
          margin: 4,
        });
        qr_code = `data:image/svg+xml;base64,${encodeBase64(new TextEncoder().encode(svg))}`;
      }
      ctx.header("Cache-Control", "no-store");
      ctx.header("Pragma", "no-cache");
      return ctx.json(
        {
          device_code,
          user_code,
          verification_uri,
          verification_uri_complete,
          ...(qr_code ? { qr_code } : {}),
          expires_in: DEVICE_CODE_LIFETIME,
          interval: DEVICE_POLL_INTERVAL,
        },
        200,
      );
    } catch (error) {
      await logMessage(ctx, client.tenant.id, {
        type: LogTypes.FAILED_DEVICE_AUTHORIZATION_REQUEST,
        description: "Device authorization request failed",
      });
      throw error;
    }
  },
});
const getActivate = defineRoute({
  route: createRoute({
    tags: ["oauth2"],
    method: "get",
    path: "/",
    request: {
      query: z.object({
        user_code: z.string().max(32).optional(),
        tenant_id: z.string().optional(),
      }),
    },
    responses: {
      302: { description: "Enter and confirm the user code in u2" },
      400: { description: "Tenant or client missing" },
    },
  }),
  handler: async (ctx) => {
    const tenantId = ctx.var.tenant_id;
    if (!tenantId)
      throw new JSONHTTPException(400, {
        error: "invalid_request",
        error_description: "A tenant is required",
      });
    await limitDeviceRequests(ctx, tenantId, "activate", 30);
    const tenant = await ctx.env.data.tenants.get(tenantId);
    const isEligible = (client: Client) =>
      client.client_metadata?.status !== "deleted" &&
      !isCimdClientId(client.client_id);
    const defaultClient = tenant?.default_client_id
      ? await ctx.env.data.clients.get(tenantId, tenant.default_client_id)
      : null;
    let clientId =
      defaultClient && isEligible(defaultClient)
        ? defaultClient.client_id
        : undefined;
    for (let page = 0; !clientId; page++) {
      const { clients } = await ctx.env.data.clients.list(tenantId, {
        page,
        per_page: 100,
      });
      clientId = clients.find(isEligible)?.client_id;
      if (clients.length < 100) break;
    }
    if (!clientId)
      throw new JSONHTTPException(400, {
        error: "invalid_request",
        error_description: "No clients configured",
      });
    const session = await createLoginSessionWithData(
      ctx.env.data.loginSessions,
      tenantId,
      {
        csrf_token: nanoid(32),
        expires_at: new Date(
          Date.now() + DEVICE_CODE_LIFETIME * 1000,
        ).toISOString(),
        authParams: { client_id: clientId },
        ip: ctx.var.ip,
        useragent: ctx.var.useragent,
      },
      { deviceFlow: { userCode: ctx.req.valid("query").user_code } },
    );
    ctx.header("Set-Cookie", deviceBrowserCookie(session));
    ctx.header("Cache-Control", "no-store");
    return ctx.redirect(
      `/u2/device/code?state=${encodeURIComponent(session.id)}`,
      302,
    );
  },
});
export const deviceCodeRoutes = new OpenAPIHono<{
  Bindings: Bindings;
  Variables: Variables;
}>().openapiRoutes([postCode] as const);
export const activateRoutes = new OpenAPIHono<{
  Bindings: Bindings;
  Variables: Variables;
}>().openapiRoutes([getActivate] as const);
