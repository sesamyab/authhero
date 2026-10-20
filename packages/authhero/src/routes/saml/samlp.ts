import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { UNIVERSAL_AUTH_SESSION_EXPIRES_IN_SECONDS } from "../../constants";
import { X509Certificate } from "@peculiar/x509";
import { nanoid } from "nanoid";
import { Bindings, Variables } from "../../types";
import {
  AuthorizationResponseMode,
  LogTypes,
} from "@authhero/adapter-interfaces";
import { logMessage } from "../../helpers/logging";
import {
  createSamlLogoutResponse,
  createSamlMetadata,
  parseSamlLogoutRequestQuery,
  parseSamlRequestQuery,
} from "../../helpers/saml";
import { clearAuthCookie, getAuthCookie } from "../../utils/cookies";
import { sendBackchannelLogout } from "../../helpers/backchannel-logout";
import { Context } from "hono";
import { stringifyAuth0Client } from "../../utils/client-info";
import { setTenantId } from "../../helpers/set-tenant-id";
import { getEnrichedClient } from "../../helpers/client";
import { isValidRedirectUrl } from "../../utils/is-valid-redirect-url";
import { JSONHTTPException } from "../../errors/json-http-exception";
import { resolveSigningKeys } from "../../helpers/signing-keys";
import { defineRoute } from "../../utils/define-route";
const getMetadataByClient_id = defineRoute({
  route: createRoute({
    tags: ["saml"],
    method: "get",
    path: "/metadata/{client_id}",
    request: {
      params: z.object({
        client_id: z.string(),
      }),
    },
    responses: {
      200: {
        description: "Decoded SAML Request",
        content: {
          "text/xml": {
            schema: z.string(),
          },
        },
      },
      400: {
        description: "Bad Request",
      },
    },
  }),
  handler: async (ctx) => {
    const { client_id } = ctx.req.valid("param");

    const client = await getEnrichedClient(ctx.env, client_id);

    // Publish every live SAML certificate, not just the signing one: a service
    // provider that reads this document can then accept assertions from both
    // the outgoing and incoming key for the length of a rotation's grace
    // period, which is what makes a zero-downtime rotation possible.
    const signingKeys = await resolveSigningKeys(
      ctx.env.data.keys,
      client.tenant.id,
      ctx.env.signingKeyMode,
      { purpose: "publish", type: "saml_encryption" },
    );

    if (signingKeys.length === 0) {
      throw new HTTPException(500, {
        message: "No signing key found",
      });
    }

    const certificates = signingKeys.map((signingKey) =>
      new X509Certificate(signingKey.cert).toString("base64"),
    );

    const issuer = ctx.env.ISSUER;

    const metadata = createSamlMetadata({
      entityId: client.addons?.samlp?.audience || client.client_id,
      certificates,
      assertionConsumerServiceUrl: `${issuer}samlp/${client_id}`,
      singleLogoutServiceUrl: `${issuer}samlp/${client_id}/logout`,
    });

    return new Response(metadata, {
      headers: {
        "Content-Type": "text/xml",
      },
    });
  },
});

const getByClient_id = defineRoute({
  route: createRoute({
    tags: ["saml"],
    method: "get",
    path: "/{client_id}",
    request: {
      query: z.object({
        SAMLRequest: z.string(),
        RelayState: z.string().optional(),
        SigAlg: z.string().optional(),
        Signature: z.string().optional(),
      }),
      params: z.object({
        client_id: z.string(),
      }),
    },
    responses: {
      200: {
        description: "Decoded SAML Request",
        content: {
          "text/xml": {
            schema: z.string(),
          },
        },
      },
      400: {
        description: "Bad Request",
      },
    },
  }),
  handler: async (ctx) => {
    const { client_id } = ctx.req.valid("param");
    const { SAMLRequest, RelayState } = ctx.req.valid("query");

    const client = await getEnrichedClient(ctx.env, client_id);
    ctx.set("client_id", client.client_id);
    setTenantId(ctx, client.tenant.id);

    // Fire-and-forget; never alters the response.
    const logRejected = (description: string) =>
      logMessage(ctx, client.tenant.id, {
        type: LogTypes.FAILED_LOGIN,
        description: `SAML: ${description}`,
        details: { client_id, reason: description },
      });

    let samlRequest: Awaited<ReturnType<typeof parseSamlRequestQuery>>;
    try {
      samlRequest = await parseSamlRequestQuery(SAMLRequest);
    } catch (err) {
      logRejected("SAMLRequest could not be parsed");
      throw err;
    }

    // Fail closed when the deployer has flagged this client as requiring
    // signed requests. Redirect-binding signature verification (xml-crypto
    // against the SP's public key from the client's SAML metadata) is not
    // yet implemented, so we cannot prove a Signature query value is valid —
    // accepting its mere presence would create the illusion of
    // authentication. Until verification lands, refuse the request entirely.
    const samlpAddon = client.addons?.samlp as
      | { require_signed_requests?: boolean }
      | undefined;
    if (samlpAddon?.require_signed_requests) {
      logRejected("SAMLRequest signature required but cannot be verified");
      throw new JSONHTTPException(400, {
        error: "invalid_request",
        error_description:
          "SAMLRequest signature verification is not implemented; require_signed_requests cannot be honored",
      });
    }

    // Validate the AssertionConsumerServiceURL against the client's registered
    // callbacks before storing it as `redirect_uri` on the login session — the
    // SAMLResponse will eventually be POST'd to this URL. Without this check
    // an attacker can submit a forged SAMLRequest pointing at their own ACS
    // URL and harvest the issued SAMLResponse (containing the user's identity
    // assertion) after the victim completes Universal Login.
    const acsUrl =
      samlRequest["samlp:AuthnRequest"]["@_AssertionConsumerServiceURL"];
    if (!acsUrl) {
      logRejected("AssertionConsumerServiceURL missing on SAMLRequest");
      throw new JSONHTTPException(400, {
        error: "invalid_request",
        error_description:
          "AssertionConsumerServiceURL is required on the SAMLRequest",
      });
    }
    if (
      !isValidRedirectUrl(acsUrl, client.callbacks || [], {
        allowPathWildcards: true,
        allowSubDomainWildcards: true,
      })
    ) {
      logRejected(
        `AssertionConsumerServiceURL ${acsUrl} is not in the client's allowed callbacks`,
      );
      throw new JSONHTTPException(400, {
        error: "invalid_request",
        error_description:
          "AssertionConsumerServiceURL is not in the client's allowed callbacks",
      });
    }

    const issuer = samlRequest["samlp:AuthnRequest"]["saml:Issuer"]["#text"];

    // Create a new Login session
    const loginSession = await ctx.env.data.loginSessions.create(
      ctx.var.tenant_id,
      {
        csrf_token: nanoid(),
        authParams: {
          client_id: client_id,
          state: JSON.stringify({
            requestId: samlRequest["samlp:AuthnRequest"]["@_ID"],
            relayState: RelayState,
          }),
          response_mode: AuthorizationResponseMode.SAML_POST,
          redirect_uri: acsUrl,
          audience: issuer,
        },
        expires_at: new Date(
          Date.now() + UNIVERSAL_AUTH_SESSION_EXPIRES_IN_SECONDS * 1000,
        ).toISOString(),
        ip: ctx.get("ip"),
        useragent: ctx.get("useragent"),
        auth0Client: stringifyAuth0Client(ctx.get("auth0_client")),
      },
    );

    logMessage(ctx, client.tenant.id, {
      type: LogTypes.INFORMATION,
      description: "SAML authentication request received",
      login_session_id: loginSession.id,
      details: {
        client_id,
        issuer,
        acs_url: acsUrl,
        request_id: samlRequest["samlp:AuthnRequest"]["@_ID"],
        login_session_id: loginSession.id,
      },
    });

    return ctx.redirect(`/u/login/identifier?state=${loginSession.id}`);
  },
});

async function handleSamlLogout(
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>,
  client_id: string,
  SAMLRequest: string,
  RelayState: string | undefined,
) {
  const client = await getEnrichedClient(ctx.env, client_id);
  ctx.set("client_id", client.client_id);
  setTenantId(ctx, client.tenant.id);
  const tenantId = client.tenant.id;

  let requestId: string | undefined;
  let sessionIndex: string | undefined;
  let nameId: string | undefined;

  const respond = async (
    success: boolean,
    description: string,
    extra: Record<string, unknown> = {},
  ) => {
    logMessage(ctx, tenantId, {
      type: success ? LogTypes.SUCCESS_LOGOUT : LogTypes.FAILED_LOGOUT,
      description: `SAML: ${description}`,
      userId: ctx.var.user_id,
      details: {
        client_id,
        request_id: requestId,
        session_index: sessionIndex,
        name_id: nameId,
        ...(success ? {} : { reason: description }),
        ...extra,
      },
    });

    const callback = (
      client.addons?.samlp as { logout?: { callback?: string } } | undefined
    )?.logout?.callback;

    const headers = new Headers();
    if (success) {
      clearAuthCookie(tenantId, ctx.var.host).forEach((c) =>
        headers.append("set-cookie", c),
      );
    }

    if (!callback) {
      headers.set("content-type", "text/html; charset=utf-8");
      headers.set("cache-control", "no-store");
      return new Response(
        success ? "You have been logged out." : "Logout failed.",
        { status: success ? 200 : 400, headers },
      );
    }

    const url = new URL(callback);
    url.searchParams.set(
      "SAMLResponse",
      await createSamlLogoutResponse({
        issuer: ctx.env.ISSUER,
        destination: callback,
        inResponseTo: requestId,
        success,
        statusMessage: description,
      }),
    );
    if (RelayState) url.searchParams.set("RelayState", RelayState);
    headers.set("location", url.toString());
    return new Response("Redirecting", { status: 302, headers });
  };

  const samlpAddon = client.addons?.samlp as
    | { require_signed_requests?: boolean }
    | undefined;
  if (!samlpAddon) {
    return respond(false, `SAML addon is not enabled for client ${client_id}`);
  }
  if (samlpAddon.require_signed_requests) {
    return respond(
      false,
      "LogoutRequest signature required but cannot be verified",
    );
  }

  try {
    const request = (await parseSamlLogoutRequestQuery(SAMLRequest))[
      "samlp:LogoutRequest"
    ];
    requestId = request["@_ID"];
    sessionIndex = request["samlp:SessionIndex"]?.["#text"];
    nameId = request["saml:NameID"]?.["#text"];
  } catch (err) {
    return respond(
      false,
      `Invalid LogoutRequest: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // The assertion's SessionIndex is the authhero session id; fall back to the
  // browser's session cookie when the SP did not send one.
  const cookie = ctx.req.header("cookie");
  const sessionId =
    sessionIndex || (cookie ? getAuthCookie(tenantId, cookie) : undefined);
  if (!sessionId) {
    return respond(false, "No session found for LogoutRequest");
  }

  const session = await ctx.env.data.sessions.get(tenantId, sessionId);
  if (!session) {
    return respond(false, "Session not found", { session_id: sessionId });
  }

  const user = await ctx.env.data.users.get(tenantId, session.user_id);
  if (user) {
    ctx.set("user_id", user.user_id);
    ctx.set("connection", user.connection);
  }

  await ctx.env.data.sessions.update(tenantId, sessionId, {
    revoked_at: new Date().toISOString(),
  });
  sendBackchannelLogout(ctx, tenantId, session);

  return respond(true, "User successfully logged out", {
    session_id: sessionId,
    login_session_id: session.login_session_id,
  });
}

const logoutResponses = {
  200: { description: "Logged out" },
  302: { description: "Redirect to the SP with a LogoutResponse" },
  400: { description: "Bad Request" },
};

const getLogout = defineRoute({
  route: createRoute({
    tags: ["saml"],
    method: "get",
    path: "/{client_id}/logout",
    request: {
      query: z.object({
        SAMLRequest: z.string(),
        RelayState: z.string().optional(),
        SigAlg: z.string().optional(),
        Signature: z.string().optional(),
      }),
      params: z.object({ client_id: z.string() }),
    },
    responses: logoutResponses,
  }),
  handler: async (ctx) => {
    const { client_id } = ctx.req.valid("param");
    const { SAMLRequest, RelayState } = ctx.req.valid("query");
    return handleSamlLogout(ctx, client_id, SAMLRequest, RelayState);
  },
});

const postLogout = defineRoute({
  route: createRoute({
    tags: ["saml"],
    method: "post",
    path: "/{client_id}/logout",
    request: {
      params: z.object({ client_id: z.string() }),
      body: {
        content: {
          "application/x-www-form-urlencoded": {
            schema: z.object({
              SAMLRequest: z.string(),
              RelayState: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: logoutResponses,
  }),
  handler: async (ctx) => {
    const { client_id } = ctx.req.valid("param");
    const { SAMLRequest, RelayState } = ctx.req.valid("form");
    return handleSamlLogout(ctx, client_id, SAMLRequest, RelayState);
  },
});

export const samlpRoutes = new OpenAPIHono<{
  Bindings: Bindings;
  Variables: Variables;
}>().openapiRoutes([
  getMetadataByClient_id,
  getByClient_id,
  getLogout,
  postLogout,
] as const);
