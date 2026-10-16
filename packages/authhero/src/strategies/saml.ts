import { Context } from "hono";
import { Bindings, Variables } from "../types";
import { AuthParams, LogTypes, User } from "@authhero/adapter-interfaces";
import { EnrichedClient } from "../helpers/client";
import { JSONHTTPException } from "../errors/json-http-exception";
import { resolveSigningKeys } from "../helpers/signing-keys";
import { logMessage } from "../helpers/logging";
// Use core import to avoid xml-crypto dependency
import { createSamlResponse, HttpSamlSigner } from "@authhero/saml/core";

// Escape values destined for an HTML attribute value (double-quoted). Without
// this, an attacker-controlled `RelayState` like `" autofocus onfocus="alert(1)`
// breaks out of the attribute and executes JS when the auto-submit form
// renders. Covers the five characters that matter inside a double-quoted attr.
function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function samlResponseForm(
  postUrl: string,
  base64EncodedSaml: string,
  relayState?: string,
) {
  const safePostUrl = escapeHtmlAttribute(postUrl);
  // SAMLResponse is already base64 — its charset can't break HTML — but
  // escape defensively in case upstream encoding ever changes.
  const safeSamlResponse = escapeHtmlAttribute(base64EncodedSaml);
  const relayStateInput = relayState
    ? `<input type="hidden" name="RelayState" value="${escapeHtmlAttribute(relayState)}" />`
    : "";

  const samlResponseTempate = `
  <!DOCTYPE html>
  <html>
  <body onload="document.forms[0].submit()">
      <noscript>
          <p>Your browser has JavaScript disabled. Please click the button below to continue:</p>
          <input type="submit" value="Continue">
      </noscript>
      <form method="post" action="${safePostUrl}">
          <input type="hidden" name="SAMLResponse" value="${safeSamlResponse}" />
          ${relayStateInput}
      </form>
      <script>
      window.onload = function() {{
          document.forms[0].submit();
      }};
      </script>
  </body>
  </html>`;

  return new Response(samlResponseTempate, {
    headers: {
      "Content-Type": "text/html",
    },
  });
}

export async function samlCallback(
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>,
  client: EnrichedClient,
  authParams: AuthParams,
  user: User,
  sid: string,
  loginSessionId?: string,
) {
  // Logging is fire-and-forget and must never change the outcome of the flow.
  const logFailure = (reason: string) =>
    logMessage(ctx, client.tenant.id, {
      type: LogTypes.FAILED_LOGIN,
      description: `SAML: ${reason}`,
      userId: user?.user_id,
      username: user?.email,
      login_session_id: loginSessionId,
      details: {
        client_id: client.client_id,
        reason,
        redirect_uri: authParams.redirect_uri,
      },
    });

  function fail(status: 400 | 500, message: string): never {
    logFailure(message);
    throw new JSONHTTPException(status, { message });
  }

  if (!authParams.redirect_uri) {
    fail(400, "Missing redirect_uri in authParams");
  }

  if (!user.email) {
    fail(400, "Missing email in user");
  }

  // Resolve through the shared helper rather than taking the first row of an
  // unsorted list: during a rotation's grace period the outgoing key is still
  // live (`revoked_at` in the future) and would otherwise have an even chance
  // of signing the assertion. The helper sorts `current_since` descending and
  // only ever returns a key that carries private material.
  const [signingKey] = await resolveSigningKeys(
    ctx.env.data.keys,
    client.tenant.id,
    ctx.env.signingKeyMode,
    { purpose: "sign", type: "saml_encryption" },
  );
  if (!signingKey) {
    fail(500, "No signing key found");
  }

  if (!client.addons?.samlp) {
    fail(400, `SAML Addon is not enabled for client ${client.client_id}`);
  }

  const { recipient, audience } = client.addons!.samlp;
  const inResponseTo = authParams.state || "";

  if (!recipient || !inResponseTo || !user || !authParams.state) {
    fail(400, `Missing recipient or inResponseTo`);
  }

  let state: { requestId: string; relayState?: string };
  let redirectUrl: URL;
  try {
    state = JSON.parse(authParams.state!);
    redirectUrl = new URL(authParams.redirect_uri!);
  } catch (err) {
    logFailure(
      `Invalid state or redirect_uri: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }

  // Priority order for SAML signer:
  // 1. Configured signer instance (ctx.env.samlSigner)
  // 2. HTTP signer via SAML_SIGN_URL
  // 3. undefined (no signing - for testing or when signature is not required)
  const signer =
    ctx.env.samlSigner ||
    (ctx.env.SAML_SIGN_URL
      ? new HttpSamlSigner(ctx.env.SAML_SIGN_URL)
      : undefined);

  const vimeoUserId = user.app_metadata?.vimeo?.user_id;
  const nameId = vimeoUserId || user.user_id;
  const assertionAudience = (audience || authParams.client_id) as string;

  let samlResponse: string;
  try {
    samlResponse = await createSamlResponse(
      {
        issuer: ctx.env.ISSUER,
        audience: assertionAudience,
        destination: redirectUrl.toString(),
        inResponseTo: state.requestId,
        userId: nameId,
        email: user.email!,
        sessionIndex: sid!,
        signature: {
          privateKeyPem: signingKey.pkcs7!,
          cert: signingKey.cert,
          kid: signingKey.kid,
        },
      },
      signer,
    );
  } catch (err) {
    logFailure(
      `Failed to create SAML response: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }

  // Never log the assertion itself, only what it was built from.
  logMessage(ctx, client.tenant.id, {
    type: LogTypes.INFORMATION,
    description: "SAML assertion issued",
    userId: user.user_id,
    username: user.email,
    audience: assertionAudience,
    login_session_id: loginSessionId,
    details: {
      client_id: client.client_id,
      name_id: nameId,
      name_id_source: vimeoUserId ? "app_metadata.vimeo.user_id" : "user_id",
      email: user.email,
      audience: assertionAudience,
      destination: redirectUrl.toString(),
      signing_key_kid: signingKey.kid,
      in_response_to: state.requestId,
    },
  });

  return samlResponseForm(
    redirectUrl.toString(),
    samlResponse,
    state.relayState,
  );
}
