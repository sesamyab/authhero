/**
 * Service-provider side of SAML 2.0: AuthHero federating to an upstream
 * identity provider (an Auth0 `samlp` connection). Everything here runs on
 * any runtime with WebCrypto and CompressionStream — no xml-crypto. Response
 * signature verification is delegated to a {@link SamlSignatureVerifier}.
 */
import { XMLBuilder, XMLParser } from "fast-xml-parser";
import { decodeBase64, encodeBase64 } from "@authhero/adapter-interfaces";
import { nanoid } from "nanoid";

export const SAML_BINDING_HTTP_REDIRECT =
  "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
export const SAML_BINDING_HTTP_POST =
  "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";

export type SamlRequestSignatureAlgorithm = "rsa-sha256" | "rsa-sha1";

const SIG_ALG_URIS: Record<SamlRequestSignatureAlgorithm, string> = {
  "rsa-sha256": "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
  "rsa-sha1": "http://www.w3.org/2000/09/xmldsig#rsa-sha1",
};

const SIG_ALG_HASHES: Record<SamlRequestSignatureAlgorithm, string> = {
  "rsa-sha256": "SHA-256",
  "rsa-sha1": "SHA-1",
};

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Raw-deflates and base64-encodes a SAML message (HTTP-Redirect binding). */
export async function deflateAndEncode(xml: string): Promise<string> {
  const stream = new Blob([new TextEncoder().encode(xml)])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return encodeBase64(bytes);
}

export interface SamlAuthnRequestParams {
  /** The IdP's SingleSignOnService URL. */
  destination: string;
  /** The SP entity ID (sent as the request's Issuer). */
  issuer: string;
  /** Where the IdP must POST the SAMLResponse. */
  assertionConsumerServiceUrl: string;
  /** Defaults to a random `_`-prefixed id. */
  id?: string;
  issueInstant?: string;
  nameIdFormat?: string;
  forceAuthn?: boolean;
}

/**
 * Builds an unsigned SAML 2.0 AuthnRequest. The response binding is always
 * HTTP-POST: that is the only binding the AuthHero ACS accepts.
 */
export function createSamlAuthnRequest(params: SamlAuthnRequestParams): {
  id: string;
  xml: string;
} {
  const id = params.id || `_${nanoid()}`;
  const issueInstant = params.issueInstant || new Date().toISOString();
  const nameIdFormat =
    params.nameIdFormat ||
    "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified";
  const forceAuthn = params.forceAuthn ? ` ForceAuthn="true"` : "";

  const xml =
    `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"` +
    ` ID="${escapeXml(id)}" Version="2.0" IssueInstant="${escapeXml(issueInstant)}"` +
    ` Destination="${escapeXml(params.destination)}"` +
    ` AssertionConsumerServiceURL="${escapeXml(params.assertionConsumerServiceUrl)}"` +
    ` ProtocolBinding="${SAML_BINDING_HTTP_POST}"${forceAuthn}>` +
    `<saml:Issuer>${escapeXml(params.issuer)}</saml:Issuer>` +
    `<samlp:NameIDPolicy Format="${escapeXml(nameIdFormat)}" AllowCreate="true"/>` +
    `</samlp:AuthnRequest>`;

  return { id, xml };
}

function pemToDer(pem: string, label: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace(new RegExp(`-----(BEGIN|END) ${label}-----`, "g"), "")
    .replace(/\s/g, "");
  // Copy into a fresh ArrayBuffer-backed view; WebCrypto rejects shared buffers.
  return Uint8Array.from(decodeBase64(body));
}

export interface SamlRedirectSigningKey {
  /** PKCS#8 PEM ("-----BEGIN PRIVATE KEY-----") of an RSA key. */
  privateKeyPem: string;
  algorithm?: SamlRequestSignatureAlgorithm;
}

/**
 * Builds the HTTP-Redirect binding URL for a SAML message (SAML 2.0 Bindings
 * §3.4.4). When `signingKey` is given the query string is signed as the spec
 * requires — over `SAMLRequest=…&RelayState=…&SigAlg=…` exactly as they
 * appear in the URL — with WebCrypto, so it works on edge runtimes.
 */
export async function createRedirectBindingUrl(params: {
  endpoint: string;
  xml: string;
  relayState?: string;
  signingKey?: SamlRedirectSigningKey;
  parameter?: "SAMLRequest" | "SAMLResponse";
}): Promise<string> {
  const parameter = params.parameter || "SAMLRequest";
  const encoded = await deflateAndEncode(params.xml);

  let query = `${parameter}=${encodeURIComponent(encoded)}`;
  if (params.relayState) {
    query += `&RelayState=${encodeURIComponent(params.relayState)}`;
  }

  if (params.signingKey) {
    const algorithm = params.signingKey.algorithm || "rsa-sha256";
    query += `&SigAlg=${encodeURIComponent(SIG_ALG_URIS[algorithm])}`;
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pemToDer(params.signingKey.privateKeyPem, "PRIVATE KEY"),
      { name: "RSASSA-PKCS1-v1_5", hash: SIG_ALG_HASHES[algorithm] },
      false,
      ["sign"],
    );
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(query),
    );
    query += `&Signature=${encodeURIComponent(encodeBase64(new Uint8Array(signature)))}`;
  }

  const separator = params.endpoint.includes("?") ? "&" : "?";
  return `${params.endpoint}${separator}${query}`;
}

/**
 * Normalizes a certificate given as PEM, base64 DER, or base64 of a PEM (the
 * shape Auth0 documents for `options.signingCert`) to its base64 DER body.
 * Returns undefined when the input is none of those.
 */
export function normalizeCertificate(input: string): string | undefined {
  // A PEM copied out of a JSON string can carry literal "\n" escapes; a
  // backslash is never part of base64, so treat them as line breaks.
  const trimmed = input.replace(/\\[rn]/g, "\n").trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("-----BEGIN")) {
    const match = trimmed.match(
      /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/,
    );
    const body = match?.[1]?.replace(/\s/g, "");
    if (!body) return undefined;
    // The armored body must itself be a DER certificate.
    const der = normalizeCertificate(body);
    return der === body ? body : undefined;
  }

  const compact = trimmed.replace(/\s/g, "");
  if (!/^[A-Za-z0-9+/]+=*$/.test(compact)) return undefined;

  let decoded: Uint8Array;
  try {
    decoded = decodeBase64(compact);
  } catch {
    return undefined;
  }
  const asText = new TextDecoder().decode(decoded.slice(0, 64));
  if (asText.trimStart().startsWith("-----BEGIN")) {
    return normalizeCertificate(new TextDecoder().decode(decoded));
  }
  // A DER certificate starts with a SEQUENCE tag.
  return decoded[0] === 0x30 ? compact : undefined;
}

/** Wraps a base64 DER certificate body in PEM armor. */
export function certificateToPem(base64Der: string): string {
  const lines = base64Der.replace(/\s/g, "").match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

export interface SamlEndpoint {
  binding: string;
  location: string;
}

export interface SamlIdpMetadata {
  entityId: string;
  singleSignOnServices: SamlEndpoint[];
  singleLogoutServices: SamlEndpoint[];
  /** Base64 DER bodies of the IdP's signing certificates. */
  signingCertificates: string[];
}

const ARRAY_TAGS = new Set([
  "EntityDescriptor",
  "IDPSSODescriptor",
  "X509Certificate",
  "SingleSignOnService",
  "SingleLogoutService",
  "KeyDescriptor",
]);

export function assertNoDoctype(xml: string) {
  // SAML never needs a DTD; refusing one up front rules out entity expansion.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error("SAML documents must not contain a DOCTYPE");
  }
}

type XmlNode = Record<string, unknown>;

function asNode(value: unknown): XmlNode | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as XmlNode)
    : undefined;
}

function asNodes(value: unknown): XmlNode[] {
  if (Array.isArray(value)) {
    return value
      .map((v) => asNode(v))
      .filter((v): v is XmlNode => v !== undefined);
  }
  const node = asNode(value);
  return node ? [node] : [];
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const node = asNode(value);
  if (!node) return undefined;
  const text = node["#text"];
  return typeof text === "string" ? text : undefined;
}

function attr(node: XmlNode | undefined, name: string): string | undefined {
  const value = node?.[`@_${name}`];
  return typeof value === "string" ? value : undefined;
}

function endpoints(value: unknown): SamlEndpoint[] {
  return asNodes(value).flatMap((n) => {
    const binding = attr(n, "Binding");
    const location = attr(n, "Location");
    return binding && location ? [{ binding, location }] : [];
  });
}

/**
 * Parses IdP metadata (an EntityDescriptor, or the first entity with an
 * IDPSSODescriptor inside an EntitiesDescriptor).
 */
export function parseSamlIdpMetadata(xml: string): SamlIdpMetadata {
  assertNoDoctype(xml);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    parseTagValue: false,
    parseAttributeValue: false,
    isArray: (name) => ARRAY_TAGS.has(name),
  });
  const doc = parser.parse(xml) as XmlNode;

  const entities = [
    ...asNodes(doc.EntityDescriptor),
    ...asNodes(asNode(doc.EntitiesDescriptor)?.EntityDescriptor),
  ];
  const entity = entities.find((e) => asNodes(e.IDPSSODescriptor).length > 0);
  const idp = entity && asNodes(entity.IDPSSODescriptor)[0];
  const entityId = attr(entity, "entityID");
  if (!entity || !idp || !entityId) {
    throw new Error("Metadata does not describe a SAML identity provider");
  }

  const signingCertificates = asNodes(idp.KeyDescriptor)
    .filter((kd) => {
      const use = attr(kd, "use");
      return !use || use === "signing";
    })
    .flatMap((kd) =>
      asNodes(asNode(kd.KeyInfo)?.X509Data).flatMap((data) =>
        (Array.isArray(data.X509Certificate)
          ? data.X509Certificate
          : [data.X509Certificate]
        )
          .map((c) => textOf(c)?.replace(/\s/g, ""))
          .filter((c): c is string => Boolean(c)),
      ),
    );

  return {
    entityId,
    singleSignOnServices: endpoints(idp.SingleSignOnService),
    singleLogoutServices: endpoints(idp.SingleLogoutService),
    signingCertificates: [...new Set(signingCertificates)],
  };
}

/** Picks the endpoint for the preferred binding, falling back to any. */
export function selectSamlEndpoint(
  services: SamlEndpoint[],
  preferredBinding: string = SAML_BINDING_HTTP_REDIRECT,
): SamlEndpoint | undefined {
  return (
    services.find((s) => s.binding === preferredBinding) ||
    services.find(
      (s) =>
        s.binding === SAML_BINDING_HTTP_REDIRECT ||
        s.binding === SAML_BINDING_HTTP_POST,
    )
  );
}

export interface SamlSpMetadataParams {
  entityId: string;
  assertionConsumerServiceUrl: string;
  /** Base64 DER bodies of the SP signing certificates (for signed requests). */
  signingCertificates?: string[];
  authnRequestsSigned?: boolean;
  nameIdFormats?: string[];
}

/** Builds the SP metadata an IdP admin imports to register AuthHero. */
export function createSamlSpMetadata(params: SamlSpMetadataParams): string {
  const spDescriptor: Record<string, unknown> = {
    "@_protocolSupportEnumeration": "urn:oasis:names:tc:SAML:2.0:protocol",
    "@_AuthnRequestsSigned": params.authnRequestsSigned ? "true" : "false",
    "@_WantAssertionsSigned": "true",
  };
  if (params.signingCertificates?.length) {
    spDescriptor.KeyDescriptor = params.signingCertificates.map((cert) => ({
      "@_use": "signing",
      KeyInfo: {
        "@_xmlns": "http://www.w3.org/2000/09/xmldsig#",
        X509Data: { X509Certificate: cert },
      },
    }));
  }
  spDescriptor.NameIDFormat = params.nameIdFormats || [
    "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
    "urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified",
  ];
  spDescriptor.AssertionConsumerService = {
    "@_Binding": SAML_BINDING_HTTP_POST,
    "@_Location": params.assertionConsumerServiceUrl,
    "@_index": "0",
    "@_isDefault": "true",
  };

  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    suppressEmptyNode: true,
    // Otherwise "true" values render as bare (invalid XML) attributes.
    suppressBooleanAttributes: false,
    format: true,
  });
  return builder.build({
    EntityDescriptor: {
      "@_xmlns": "urn:oasis:names:tc:SAML:2.0:metadata",
      "@_entityID": params.entityId,
      SPSSODescriptor: spDescriptor,
    },
  });
}
