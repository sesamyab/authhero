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
      /** The root element the signature must cover. */
      rootElement: "AuthnRequest" | "LogoutRequest";
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

/**
 * The exact, untrimmed ID attribute of the document's root element, when the
 * root is `rootElement`. Attribute values must not be trimmed here: xml-crypto
 * resolves a reference by the exact value, so `ID=" _r "` and `ID="_r"` are
 * different elements to it.
 */
function rootId(xml: string, rootElement: string): string | undefined {
  try {
    const doc = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      removeNSPrefix: true,
      trimValues: false,
      parseAttributeValue: false,
      ignoreDeclaration: true,
      ignorePiTags: true,
    }).parse(xml) as Record<string, unknown>;
    const elements = Object.keys(doc).filter(
      (key) => !key.startsWith("@_") && !key.startsWith("#"),
    );
    if (elements.length !== 1 || elements[0] !== rootElement) return undefined;
    const root = doc[rootElement];
    if (!root || typeof root !== "object" || Array.isArray(root)) {
      return undefined;
    }
    const id = (root as Record<string, unknown>)["@_ID"];
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
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
 * the document's root request element itself: a signed reference counts only
 * when its root has exactly the posted root's ID, and IDs are unique (the
 * verifier refuses duplicates), so a signed element wrapped in an unsigned
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

  const postedRootId = rootId(request.xml, request.rootElement);
  if (!postedRootId) {
    throw new SamlRequestSignatureError(
      `SAMLRequest signature verification failed: the message is not a single ${request.rootElement} with an ID`,
    );
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
    !references.some(
      (reference) => rootId(reference, request.rootElement) === postedRootId,
    )
  ) {
    throw new SamlRequestSignatureError(
      "SAMLRequest signature verification failed: the request is not signed",
    );
  }
}
