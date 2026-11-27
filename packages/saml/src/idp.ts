/**
 * Identity-provider side helpers: reading AuthnRequests from any SAML SP and
 * verifying HTTP-Redirect binding signatures.
 */
import { XMLParser } from "fast-xml-parser";
import { decodeBase64 } from "@authhero/adapter-interfaces";
import { assertNoDoctype } from "./sp";

export interface SamlAuthnRequestInfo {
  id: string;
  issuer?: string;
  assertionConsumerServiceUrl?: string;
  destination?: string;
  protocolBinding?: string;
  issueInstant?: string;
  forceAuthn: boolean;
}

function stringAttr(node: Record<string, unknown>, name: string) {
  const value = node[`@_${name}`];
  return typeof value === "string" ? value : undefined;
}

/**
 * Parses an AuthnRequest whatever namespace prefix the SP uses (`samlp:`,
 * `saml2p:`, a default namespace, …).
 */
export function parseSamlAuthnRequest(xml: string): SamlAuthnRequestInfo {
  assertNoDoctype(xml);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
  });
  const doc = parser.parse(xml) as Record<string, unknown>;
  const request = doc.AuthnRequest;
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("SAMLRequest is not an AuthnRequest");
  }
  const node = request as Record<string, unknown>;
  const id = stringAttr(node, "ID");
  if (!id) throw new Error("AuthnRequest has no ID");

  const issuerNode = node.Issuer;
  const issuer =
    typeof issuerNode === "string"
      ? issuerNode
      : issuerNode && typeof issuerNode === "object"
        ? (issuerNode as Record<string, unknown>)["#text"]
        : undefined;

  return {
    id,
    issuer: typeof issuer === "string" && issuer ? issuer : undefined,
    assertionConsumerServiceUrl: stringAttr(
      node,
      "AssertionConsumerServiceURL",
    ),
    destination: stringAttr(node, "Destination"),
    protocolBinding: stringAttr(node, "ProtocolBinding"),
    issueInstant: stringAttr(node, "IssueInstant"),
    // xs:boolean: "true" and "1" are both true.
    forceAuthn: ["true", "1"].includes(
      stringAttr(node, "ForceAuthn")?.trim().toLowerCase() ?? "",
    ),
  };
}

/** Decodes a base64 HTTP-POST binding message (not deflated). */
export function decodeSamlPostMessage(value: string): string {
  return new TextDecoder().decode(decodeBase64(value.replace(/\s/g, "")));
}

const REDIRECT_SIG_ALGS: Record<string, string> = {
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256": "SHA-256",
  "http://www.w3.org/2001/04/xmldsig-more#rsa-sha512": "SHA-512",
  "http://www.w3.org/2000/09/xmldsig#rsa-sha1": "SHA-1",
};

/**
 * Splits a raw query string into its still URL-encoded values. Throws on a
 * repeated parameter: which copy was signed would be ambiguous.
 */
function rawQueryValues(rawQuery: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const part of rawQuery.replace(/^\?/, "").split("&")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = decodeURIComponent(eq === -1 ? part : part.slice(0, eq));
    if (values.has(key)) {
      throw new Error(`Query parameter ${key} is repeated`);
    }
    values.set(key, eq === -1 ? "" : part.slice(eq + 1));
  }
  return values;
}

/**
 * Verifies an HTTP-Redirect binding signature (SAML 2.0 Bindings §3.4.4.1):
 * the signature covers `SAMLRequest=…&RelayState=…&SigAlg=…` with the values
 * exactly as they appear, still URL-encoded, in the request URL.
 *
 * @param spkiKeys the signer's public keys as DER SubjectPublicKeyInfo.
 * @returns false when no key validates the signature.
 * @throws when the signature or SigAlg is missing or the algorithm unsupported.
 */
export async function verifyRedirectBindingSignature(params: {
  rawQuery: string;
  parameter: "SAMLRequest" | "SAMLResponse";
  spkiKeys: Uint8Array[];
}): Promise<boolean> {
  const values = rawQueryValues(params.rawQuery);
  const message = values.get(params.parameter);
  const rawSigAlg = values.get("SigAlg");
  const rawSignature = values.get("Signature");
  if (message === undefined || !rawSigAlg || !rawSignature) {
    throw new Error("The request is not signed");
  }
  const sigAlg = decodeURIComponent(rawSigAlg.replace(/\+/g, "%20"));
  const hash = REDIRECT_SIG_ALGS[sigAlg];
  if (!hash) {
    throw new Error(`Unsupported SigAlg ${sigAlg}`);
  }

  const relayState = values.get("RelayState");
  const signedOctets = new TextEncoder().encode(
    `${params.parameter}=${message}` +
      (relayState !== undefined ? `&RelayState=${relayState}` : "") +
      `&SigAlg=${rawSigAlg}`,
  );
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = Uint8Array.from(
      decodeBase64(
        decodeURIComponent(rawSignature.replace(/\+/g, "%20")).replace(
          /\s/g,
          "",
        ),
      ),
    );
  } catch {
    return false;
  }

  for (const spki of params.spkiKeys) {
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey(
        "spki",
        Uint8Array.from(spki),
        { name: "RSASSA-PKCS1-v1_5", hash },
        false,
        ["verify"],
      );
    } catch {
      // Not an RSA key (e.g. EC): it can't have made this signature.
      continue;
    }
    if (
      await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        signature,
        signedOctets,
      )
    ) {
      return true;
    }
  }
  return false;
}
