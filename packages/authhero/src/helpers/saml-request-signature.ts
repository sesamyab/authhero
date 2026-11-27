import { Context } from "hono";
import { X509Certificate } from "@peculiar/x509";
import { XMLParser } from "fast-xml-parser";
import {
  certificateToPem,
  normalizeCertificate,
  verifyRedirectBindingSignature,
} from "@authhero/saml/core";
import { Bindings, Variables } from "../types";
import { EnrichedClient } from "./client";

type SamlRequestToVerify =
  | {
      binding: "redirect";
      /** The raw, still URL-encoded query string of the request. */
      rawQuery: string;
    }
  | {
      binding: "post";
      xml: string;
      /** The root element and ID the signature must cover. */
      rootElement: "AuthnRequest" | "LogoutRequest";
      requestId: string;
    };

export class SamlRequestSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SamlRequestSignatureError";
  }
}

interface SamlpAddonSigning {
  signingCert?: string;
  require_signed_requests?: boolean;
}

function getAddonSigning(client: EnrichedClient): SamlpAddonSigning {
  const addon: unknown = client.addons?.samlp;
  if (!addon || typeof addon !== "object") return {};
  const { signingCert, require_signed_requests } = addon as Record<
    string,
    unknown
  >;
  return {
    signingCert: typeof signingCert === "string" ? signingCert : undefined,
    require_signed_requests: require_signed_requests === true,
  };
}

function signedRootMatches(
  reference: string,
  rootElement: string,
  requestId: string,
): boolean {
  try {
    const doc = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      removeNSPrefix: true,
    }).parse(reference) as Record<string, unknown>;
    const root = doc[rootElement];
    return (
      !!root &&
      typeof root === "object" &&
      (root as Record<string, unknown>)["@_ID"] === requestId
    );
  } catch {
    return false;
  }
}

/**
 * Enforces signed SAML requests from a service provider, as Auth0 does: when
 * the client's samlp addon has a `signingCert`, every AuthnRequest and
 * LogoutRequest must be signed with it. `require_signed_requests` without a
 * certificate fails closed, since nothing can be verified.
 *
 * HTTP-Redirect signatures are checked with WebCrypto. HTTP-POST requests
 * carry an XML signature, checked with `ctx.env.samlVerifier`; it must cover
 * the request element itself, so a signed element wrapped in an unsigned
 * request is refused.
 *
 * @throws SamlRequestSignatureError when the request must be signed and isn't.
 */
export async function verifySamlRequestSignature(
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>,
  client: EnrichedClient,
  request: SamlRequestToVerify,
): Promise<void> {
  const { signingCert, require_signed_requests } = getAddonSigning(client);
  if (!signingCert && !require_signed_requests) return;

  const certBody = signingCert ? normalizeCertificate(signingCert) : undefined;
  if (!certBody) {
    throw new SamlRequestSignatureError(
      "SAMLRequest signature verification needs a valid signingCert on the client's samlp addon; require_signed_requests cannot be honored",
    );
  }
  const certPem = certificateToPem(certBody);

  if (request.binding === "redirect") {
    let valid: boolean;
    try {
      valid = await verifyRedirectBindingSignature({
        rawQuery: request.rawQuery,
        parameter: "SAMLRequest",
        spkiKeys: [
          new Uint8Array(new X509Certificate(certPem).publicKey.rawData),
        ],
      });
    } catch (err) {
      throw new SamlRequestSignatureError(
        `SAMLRequest signature verification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!valid) {
      throw new SamlRequestSignatureError(
        "SAMLRequest signature verification failed: the signature is invalid",
      );
    }
    return;
  }

  const verifier = ctx.env.samlVerifier;
  if (!verifier) {
    throw new SamlRequestSignatureError(
      "SAMLRequest signature verification over HTTP-POST needs a samlVerifier passed to init()",
    );
  }
  let references: string[];
  try {
    references = await verifier.verifySignedReferences(request.xml, [certPem]);
  } catch (err) {
    throw new SamlRequestSignatureError(
      `SAMLRequest signature verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    !references.some((reference) =>
      signedRootMatches(reference, request.rootElement, request.requestId),
    )
  ) {
    throw new SamlRequestSignatureError(
      "SAMLRequest signature verification failed: the request is not signed",
    );
  }
}
