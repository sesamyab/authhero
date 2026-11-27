import { Context } from "hono";
import { HTTPException } from "hono/http-exception";
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
 * Metadata is (re)read when it is new or changed, or when the options still
 * lack a sign-in endpoint or certificate. Also rejects a signingCert that is
 * not a certificate, so a paste error fails the save, not every login.
 */
export async function resolveSamlConnectionOptions(
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>,
  options: ConnectionOptions,
  previous?: ConnectionOptions,
): Promise<ConnectionOptions> {
  const resolved: ConnectionOptions = { ...options };

  const xmlChanged =
    resolved.metadataXml !== undefined &&
    resolved.metadataXml !== previous?.metadataXml;
  const urlChanged =
    resolved.metadataUrl !== undefined &&
    resolved.metadataUrl !== previous?.metadataUrl;
  const incomplete = !resolved.signInEndpoint || !resolved.signingCert;

  let metadataXml: string | undefined;
  if (resolved.metadataXml && (xmlChanged || incomplete)) {
    metadataXml = resolved.metadataXml;
  } else if (resolved.metadataUrl && (urlChanged || incomplete)) {
    metadataXml = await fetchMetadata(ctx, resolved.metadataUrl);
  }

  if (metadataXml) {
    let metadata: ReturnType<typeof parseSamlIdpMetadata>;
    try {
      metadata = parseSamlIdpMetadata(metadataXml);
    } catch (err) {
      badRequest(
        `Invalid SAML metadata: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const preferred =
      resolved.protocolBinding === SAML_BINDING_HTTP_POST
        ? SAML_BINDING_HTTP_POST
        : SAML_BINDING_HTTP_REDIRECT;
    const signIn = selectSamlEndpoint(metadata.singleSignOnServices, preferred);
    if (!signIn) {
      badRequest(
        "Invalid SAML metadata: no SingleSignOnService with the HTTP-Redirect or HTTP-POST binding",
      );
    }
    const [firstCert, ...otherCerts] = metadata.signingCertificates;
    if (!firstCert) {
      badRequest("Invalid SAML metadata: no signing certificate");
    }

    resolved.signInEndpoint = signIn.location;
    // Follow the binding the IdP actually offers at that endpoint.
    resolved.protocolBinding = signIn.binding;
    resolved.signOutEndpoint = selectSamlEndpoint(
      metadata.singleLogoutServices,
    )?.location;
    resolved.signingCert = certificateToPem(firstCert);
    resolved.signingCerts = otherCerts.length
      ? otherCerts.map((c) => certificateToPem(c))
      : undefined;
    resolved.issuer = metadata.entityId;
  }

  for (const cert of [
    ...(resolved.signingCert ? [resolved.signingCert] : []),
    ...(resolved.signingCerts || []),
  ]) {
    if (!normalizeCertificate(cert)) {
      badRequest(
        "signingCert must be an X.509 certificate (PEM, base64 DER or base64 PEM)",
      );
    }
  }

  return resolved;
}
