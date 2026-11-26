import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  AuthParams,
  AuthorizationResponseType,
  authParamsSchema,
} from "@authhero/adapter-interfaces";
import { Bindings, Variables } from "../../types";
import generateOTP from "../../utils/otp";
import { sendCode, sendLink } from "../../emails";
import { OTP_EXPIRATION_TIME } from "../../constants";
import { getEnrichedClient } from "../../helpers/client";
import { missingGrantTypeForResponseType } from "../../helpers/response-type-grants";
import { HTTPException } from "hono/http-exception";
import { prefetchClientBundle } from "../../helpers/prefetch-client-bundle";
import { cimdTenantHint, isCimdClientId } from "../../helpers/cimd";
import { passwordlessGrant } from "../../authentication-flows/passwordless";
import { nanoid } from "nanoid";
import { stringifyAuth0Client } from "../../utils/client-info";
import {
  getSelfCallbackWildcards,
  getUniversalLoginUrl,
} from "../../variables";
import { isValidRedirectUrl } from "../../utils/is-valid-redirect-url";
import { setTenantId } from "../../helpers/set-tenant-id";
import { defineRoute } from "../../utils/define-route";
import { normalizeEmail } from "../../utils/email";
import { JSONHTTPException } from "../../errors/json-http-exception";

/**
 * The message of a passwordless failure that may be shown to the user
 * (`userSafe` errors such as an expired code). The invalid-session screen
 * displays the `error` it is given, so anything else stays generic.
 */
function getUserSafeMessage(err: unknown): string | undefined {
  if (!(err instanceof JSONHTTPException)) return undefined;
  try {
    const body: unknown = JSON.parse(err.message);
    if (
      body &&
      typeof body === "object" &&
      (body as { userSafe?: unknown }).userSafe === true &&
      typeof (body as { message?: unknown }).message === "string"
    ) {
      return (body as { message: string }).message;
    }
  } catch {
    // Not a JSON body
  }
  return undefined;
}
const postStart = defineRoute({
  route: createRoute({
    tags: ["passwordless"],
    method: "post",
    path: "/start",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.union([
              z.object({
                connection: z.literal("email"),
                client_id: z.string(),
                email: z.string().transform((u) => normalizeEmail(u)),
                send: z.enum(["link", "code"]),
                authParams: authParamsSchema.omit({ client_id: true }),
              }),
              z.object({
                client_id: z.string(),
                connection: z.literal("sms"),
                phone_number: z.string(),
                send: z.enum(["link", "code"]),
                authParams: authParamsSchema.omit({ client_id: true }),
              }),
            ]),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Status",
      },
    },
  }),
  handler: async (ctx) => {
    const body = ctx.req.valid("json");
    const { env } = ctx;
    const { client_id, send, authParams, connection } = body;
    if (!isCimdClientId(client_id)) {
      await prefetchClientBundle(ctx, { client_id }).catch(() => {});
    }
    const client = await getEnrichedClient(
      ctx.env,
      client_id,
      cimdTenantHint(client_id, ctx.var.tenant_id),
    );
    ctx.set("client_id", client.client_id);
    setTenantId(ctx, client.tenant.id);

    const username = connection === "email" ? body.email : body.phone_number;

    const ip = ctx.get("ip");
    const useragent = ctx.get("useragent");
    const auth0_client = ctx.get("auth0_client");

    // Convert structured auth0_client back to string for storage
    const auth0Client = stringifyAuth0Client(auth0_client);

    const resolvedAudience =
      authParams.audience ?? client.tenant.default_audience;

    const loginSession = await env.data.loginSessions.create(client.tenant.id, {
      authParams: {
        ...authParams,
        client_id,
        username,
        audience: resolvedAudience,
      },
      expires_at: new Date(Date.now() + OTP_EXPIRATION_TIME).toISOString(),
      csrf_token: nanoid(),
      ip,
      useragent,
      auth0Client,
    });

    const code = await env.data.codes.create(client.tenant.id, {
      code_id: generateOTP(),
      code_type: "otp",
      login_id: loginSession.id,
      expires_at: new Date(Date.now() + OTP_EXPIRATION_TIME).toISOString(),
      redirect_uri: authParams.redirect_uri,
    });

    // Extract language from ui_locales
    const language = authParams?.ui_locales
      ?.split(" ")
      ?.map((locale) => locale.split("-")[0])[0];

    if (send === "link") {
      await sendLink(ctx, {
        to: username,
        code: code.code_id,
        authParams: {
          ...authParams,
          client_id,
          audience: resolvedAudience,
        },
        language,
      });
    } else {
      await sendCode(ctx, {
        to: username,
        code: code.code_id,
        language,
      });
    }

    return ctx.html("OK");
  },
});

const getVerifyRedirect = defineRoute({
  route: createRoute({
    tags: ["passwordless"],
    method: "get",
    path: "/verify_redirect",
    request: {
      query: z.object({
        scope: z.string(),
        response_type: z.nativeEnum(AuthorizationResponseType),
        redirect_uri: z.string(),
        state: z.string(),
        nonce: z.string().optional(),
        verification_code: z.string(),
        connection: z.string(),
        client_id: z.string(),
        email: z.string().transform((u) => normalizeEmail(u)),
        audience: z.string().optional(),
      }),
    },
    responses: {
      302: {
        description: "Successful verification, redirecting to continue flow.",
        headers: z.object({ Location: z.string().url() }).openapi({}), // Added Location header spec
      },
      400: {
        description:
          "Bad Request (e.g., invalid client, invalid code, missing parameters).",
        content: {
          "application/json": {
            schema: z.object({
              error: z.string(),
              error_description: z.string().optional(),
            }),
          },
        },
      },
      500: {
        description: "Internal Server Error.",
        content: {
          "application/json": {
            schema: z.object({
              error: z.string(),
              error_description: z.string().optional(),
            }),
          },
        },
      },
    },
  }),
  handler: async (ctx) => {
    const { env } = ctx;
    const {
      client_id,
      email,
      verification_code,
      redirect_uri,
      state,
      scope,
      audience,
      response_type,
      nonce,
    } = ctx.req.valid("query");

    if (!isCimdClientId(client_id)) {
      await prefetchClientBundle(ctx, { client_id }).catch(() => {});
    }
    const client = await getEnrichedClient(
      env,
      client_id,
      cimdTenantHint(client_id, ctx.var.tenant_id),
    );

    ctx.set("client_id", client.client_id);
    setTenantId(ctx, client.tenant.id);
    ctx.set("connection", "email");

    // Same rule as /authorize, checked before the code is used up.
    const missingGrantType = missingGrantTypeForResponseType(
      client.grant_types,
      response_type,
    );
    if (missingGrantType) {
      throw new HTTPException(400, {
        message: `Grant type '${missingGrantType}' not allowed for the client.`,
      });
    }

    const authParams: AuthParams = {
      client_id,
      redirect_uri,
      state,
      nonce,
      scope,
      audience,
      response_type,
    };

    let errorMessage = "Something went wrong. Please try again later.";
    try {
      const result = await passwordlessGrant(ctx, {
        client_id,
        username: email,
        otp: verification_code,
        authParams,
        enforceIpCheck: true,
      });

      if (result instanceof Response) {
        return result;
      } else if (
        result &&
        typeof result === "object" &&
        "access_token" in result
      ) {
        return ctx.json(result);
      }
    } catch (err: unknown) {
      errorMessage = getUserSafeMessage(err) ?? errorMessage;
    }

    // Create a new login session with the error message
    const ip = ctx.get("ip");
    const useragent = ctx.get("useragent");
    const auth0_client = ctx.get("auth0_client");

    // Convert structured auth0_client back to string for storage
    const auth0Client = stringifyAuth0Client(auth0_client);

    // The invalid-session screen offers redirect_uri as its way back, so only
    // keep it when it is one of the client's callbacks (the /authorize rule).
    const validCallbacks = [...(client.callbacks || [])];
    if (ctx.var.host) {
      validCallbacks.push(
        ...getSelfCallbackWildcards(ctx.env, ctx.var.custom_domain),
      );
    }
    const allowedRedirectUri =
      authParams.redirect_uri &&
      isValidRedirectUrl(authParams.redirect_uri, validCallbacks, {
        allowPathWildcards: true,
        allowSubDomainWildcards: true,
      })
        ? authParams.redirect_uri
        : undefined;

    const loginSession = await env.data.loginSessions.create(client.tenant.id, {
      authParams: {
        ...authParams,
        redirect_uri: allowedRedirectUri,
        username: email,
        audience: authParams.audience ?? client.tenant.default_audience,
      },
      expires_at: new Date(Date.now() + OTP_EXPIRATION_TIME).toISOString(),
      csrf_token: nanoid(),
      ip,
      useragent,
      auth0Client,
    });

    return ctx.redirect(
      `${getUniversalLoginUrl(ctx.env, ctx.var.custom_domain)}invalid-session?state=${encodeURIComponent(loginSession.id)}&error=${encodeURIComponent(errorMessage)}`,
      302,
    );
  },
});

export const passwordlessRoutes = new OpenAPIHono<{
  Bindings: Bindings;
  Variables: Variables;
}>().openapiRoutes([postStart, getVerifyRedirect] as const);
