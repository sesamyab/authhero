import { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { X509Certificate } from "@peculiar/x509";
import { Connection } from "@authhero/adapter-interfaces";
import {
  certificateToPem,
  normalizeCertificate,
  parseSamlIdpMetadata,
  SAML_BINDING_HTTP_POST,
  SAML_BINDING_HTTP_REDIRECT,
  selectSamlEndpoint,
} from "@authhero/saml/core";
import { Bindings, Variables } from "../types";
import { ssrfFetchOptionsFromEnv, ssrfSafeFetch } from "../utils/ssrf-fetch";

type ConnectionOptions = Connection["options"];

const MAX_METADATA_BYTES = 512 * 1024;

function badRequest(message: string): never {
  throw new HTTPException(400, { message });
}

async function fetchMetadata(
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>,
  url: string,
): Promise<string> {
  try {
    const response = await ssrfSafeFetch(url, {
      ...ssrfFetchOptionsFromEnv(ctx.env),
      maxBytes: MAX_METADATA_BYTES,
      timeoutMs: 10_000,
      accept:
        "application/samlmetadata+xml, application/xml, text/xml;q=0.9, */*;q=0.1",
    });
    if (response.status < 200 || response.status >= 300) {
      badRequest(
        `SAML metadata could not be fetched from metadataUrl (status ${response.status})`,
      );
    }
    return response.body;
  } catch (err) {
    if (err instanceof HTTPException) throw err;
    badRequest(
      `SAML metadata could not be fetched from metadataUrl: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Fills a `samlp` connection's options from IdP metadata, the way Auth0 does
 * when `metadataXml` or `metadataUrl` is set: signInEndpoint, signOutEndpoint,
 * signingCert(s) and the IdP entity ID (stored as `issuer`, which responses
 * are then checked against).
 *
 * Metadata is (re)read when it is new or changed, when clearing
 * `metadataXml` leaves `metadataUrl` as the only source, when the request
 * binding changed, or when the options still lack a sign-in endpoint or
 * certificate, so the saved values always come from the current source and
 * the saved endpoint is one the IdP offers for the saved binding.
 * Then validates the result, so a bad configuration fails the save rather
 * than every login: certificates must parse as X.509, and signed requests
 * need the HTTP-Redirect binding.
 */
export async function resolveSamlConnectionOptions(
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>,
  options: ConnectionOptions,
  previous?: ConnectionOptions,
): Promise<ConnectionOptions> {
  const resolved: ConnectionOptions = { ...options };

  const xmlChanged = resolved.metadataXml !== previous?.metadataXml;
  const urlChanged = resolved.metadataUrl !== previous?.metadataUrl;
  // The saved values came from the XML that is now gone.
  const xmlCleared = Boolean(previous?.metadataXml) && !resolved.metadataXml;
  const bindingChanged = resolved.protocolBinding !== previous?.protocolBinding;
  const incomplete = !resolved.signInEndpoint || !resolved.signingCert;
  const reread = incomplete || bindingChanged;

  // An empty metadataXml field is a cleared field, not a metadata source.
  let metadataXml: string | undefined;
  if (resolved.metadataXml && (xmlChanged || reread)) {
    metadataXml = resolved.metadataXml;
  } else if (resolved.metadataUrl && (urlChanged || reread || xmlCleared)) {
    metadataXml = await fetchMetadata(ctx, resolved.metadataUrl);
    if (!metadataXml.trim()) {
      badRequest("SAML metadata downloaded from metadataUrl is empty");
    }
  }

  if (metadataXml !== undefined) {
    let metadata: ReturnType<typeof parseSamlIdpMetadata>;
    try {
      metadata = parseSamlIdpMetadata(metadataXml);
    } catch (err) {
      badRequest(
        `Invalid SAML metadata: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // An explicitly chosen binding must be one the IdP offers; otherwise
    // prefer HTTP-Redirect and fall back to HTTP-POST.
    const signIn = resolved.protocolBinding
      ? metadata.singleSignOnServices.find(
          (s) => s.binding === resolved.protocolBinding,
        )
      : selectSamlEndpoint(
          metadata.singleSignOnServices,
          SAML_BINDING_HTTP_REDIRECT,
        );
    if (!signIn) {
      badRequest(
        resolved.protocolBinding
          ? `Invalid SAML metadata: no SingleSignOnService with the ${resolved.protocolBinding} binding`
          : "Invalid SAML metadata: no SingleSignOnService with the HTTP-Redirect or HTTP-POST binding",
      );
    }
    const [firstCert, ...otherCerts] = metadata.signingCertificates;
    if (!firstCert) {
      badRequest("Invalid SAML metadata: no signing certificate");
    }

    resolved.signInEndpoint = signIn.location;
    resolved.protocolBinding =
      signIn.binding === SAML_BINDING_HTTP_POST
        ? SAML_BINDING_HTTP_POST
        : SAML_BINDING_HTTP_REDIRECT;
    resolved.signOutEndpoint = selectSamlEndpoint(
      metadata.singleLogoutServices,
    )?.location;
    resolved.signingCert = certificateToPem(firstCert);
    resolved.signingCerts = otherCerts.length
      ? otherCerts.map((c) => certificateToPem(c))
      : undefined;
    resolved.issuer = metadata.entityId;
  }

  if (
    resolved.signSAMLRequest &&
    resolved.protocolBinding === SAML_BINDING_HTTP_POST
  ) {
    badRequest(
      "signSAMLRequest needs the HTTP-Redirect binding: signed AuthnRequests over HTTP-POST are not supported",
    );
  }

  for (const cert of [
    ...(resolved.signingCert ? [resolved.signingCert] : []),
    ...(resolved.signingCerts || []),
  ]) {
    const body = normalizeCertificate(cert);
    let parsed = false;
    if (body) {
      try {
        new X509Certificate(certificateToPem(body));
        parsed = true;
      } catch {
        // falls through to the error below
      }
    }
    if (!parsed) {
      badRequest(
        "signingCert must be an X.509 certificate (PEM, base64 DER or base64 PEM)",
      );
    }
  }

  return resolved;
}
