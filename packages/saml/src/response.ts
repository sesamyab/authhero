/**
 * Validates a SAMLResponse posted to the AuthHero assertion consumer service
 * (Web Browser SSO profile, HTTP-POST binding).
 *
 * Signature wrapping defense: the assertion is read only from the canonical
 * XML the verifier reports as signed, never from the posted document. The
 * posted document is used for the top-level status (which can only make the
 * login fail) and to check it carries exactly one assertion.
 */
import { XMLParser } from "fast-xml-parser";
import { decodeBase64 } from "@authhero/adapter-interfaces";
import { SamlSignatureVerifier } from "./verifier";
import { assertNoDoctype, certificateToPem, normalizeCertificate } from "./sp";

const BEARER = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const STATUS_SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";

export type SamlResponseErrorCode =
  | "invalid_response"
  | "idp_error"
  | "unsigned"
  | "invalid_signature"
  | "encrypted_assertion"
  | "issuer_mismatch"
  | "audience_mismatch"
  | "recipient_mismatch"
  | "in_response_to_mismatch"
  | "expired"
  | "not_yet_valid"
  | "missing_subject";

export class SamlResponseError extends Error {
  readonly code: SamlResponseErrorCode;
  /** For `idp_error`: the IdP's status codes and message. */
  readonly status?: { code?: string; subCode?: string; message?: string };

  constructor(
    code: SamlResponseErrorCode,
    message: string,
    status?: SamlResponseError["status"],
  ) {
    super(message);
    this.name = "SamlResponseError";
    this.code = code;
    this.status = status;
  }
}

export interface ValidateSamlResponseParams {
  /** The base64 `SAMLResponse` form value. */
  samlResponse: string;
  verifier: SamlSignatureVerifier;
  /** Trusted IdP signing certificates: PEM, base64 DER or base64 PEM. */
  idpCertificates: string[];
  /** The SP entity ID; must be an Audience of the assertion. */
  spEntityId: string;
  /** The ACS URL the response was posted to; must be its Recipient. */
  assertionConsumerServiceUrl: string;
  /**
   * The ID of the AuthnRequest this response answers. Omit only to accept an
   * unsolicited (IdP-initiated) response, which then must not carry one.
   */
  inResponseTo?: string;
  /** When set, the assertion's Issuer must equal it. */
  idpEntityId?: string;
  clockSkewSeconds?: number;
  now?: Date;
}

export interface SamlAssertion {
  assertionId: string;
  issuer?: string;
  nameId: string;
  nameIdFormat?: string;
  sessionIndex?: string;
  authnInstant?: string;
  inResponseTo?: string;
  /** Attribute name → value (string) or values (string[]). */
  attributes: Record<string, string | string[]>;
  /** Last instant the assertion is acceptable; a replay cache can expire then. */
  notOnOrAfter?: string;
}

type XmlNode = Record<string, unknown>;

function asNode(value: unknown): XmlNode | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as XmlNode)
    : undefined;
}

function asNodes(value: unknown): XmlNode[] {
  const list = Array.isArray(value) ? value : [value];
  return list
    .map((v) => asNode(v))
    .filter((v): v is XmlNode => v !== undefined);
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  const node = asNode(value);
  if (!node) return undefined;
  const text = node["#text"];
  if (typeof text === "string") return text;
  // An element with attributes but no text (e.g. `<AttributeValue xsi:type=…/>`).
  return "";
}

function attr(node: XmlNode | undefined, name: string): string | undefined {
  const value = node?.[`@_${name}`];
  return typeof value === "string" ? value : undefined;
}

const ARRAY_TAGS = new Set([
  "Assertion",
  "EncryptedAssertion",
  "AudienceRestriction",
  "Audience",
  "SubjectConfirmation",
  "AuthnStatement",
  "AttributeStatement",
  "Attribute",
  "AttributeValue",
]);

function parse(xml: string): XmlNode {
  assertNoDoctype(xml);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true,
    // Identifiers like "00123" must stay strings.
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    isArray: (name) => ARRAY_TAGS.has(name),
  });
  return parser.parse(xml) as XmlNode;
}

function sameUrl(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

function parseInstant(value: string | undefined, field: string) {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new SamlResponseError("invalid_response", `Invalid ${field}`);
  }
  return ms;
}

function decodeResponse(samlResponse: string): string {
  try {
    return new TextDecoder().decode(
      decodeBase64(samlResponse.replace(/\s/g, "")),
    );
  } catch {
    throw new SamlResponseError(
      "invalid_response",
      "SAMLResponse is not valid base64",
    );
  }
}

function collectAttributes(assertion: XmlNode) {
  // A Map, so attribute names like "toString" or "__proto__" never meet
  // Object.prototype; fromEntries then defines them as own properties.
  const attributes = new Map<string, string | string[]>();
  for (const statement of asNodes(assertion.AttributeStatement)) {
    for (const attribute of asNodes(statement.Attribute)) {
      const name = attr(attribute, "Name");
      if (!name) continue;
      const rawValues = attribute.AttributeValue;
      const values = (Array.isArray(rawValues) ? rawValues : [rawValues])
        .map((v) => textOf(v))
        .filter((v): v is string => v !== undefined);
      if (values.length === 0) continue;
      const existing = attributes.get(name);
      const merged = [
        ...(existing === undefined
          ? []
          : Array.isArray(existing)
            ? existing
            : [existing]),
        ...values,
      ];
      attributes.set(name, merged.length === 1 ? merged[0]! : merged);
    }
  }
  return Object.fromEntries(attributes);
}

// Conditions this SP evaluates or may ignore. OneTimeUse holds: each login's
// state is consumed on first use. ProxyRestriction only constrains assertions
// the SP issues on to others. Any other condition (a typed <Condition>) is not
// understood, so the assertion is invalid (SAML Core §2.5.1).
const UNDERSTOOD_CONDITIONS = new Set([
  "AudienceRestriction",
  "OneTimeUse",
  "ProxyRestriction",
]);

export async function validateSamlResponse(
  params: ValidateSamlResponseParams,
): Promise<SamlAssertion> {
  const now = (params.now ?? new Date()).getTime();
  const skew = (params.clockSkewSeconds ?? 120) * 1000;
  const xml = decodeResponse(params.samlResponse);

  let doc: XmlNode;
  try {
    doc = parse(xml);
  } catch (err) {
    throw new SamlResponseError(
      "invalid_response",
      `SAMLResponse could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const response = asNode(doc.Response);
  if (!response) {
    throw new SamlResponseError(
      "invalid_response",
      "SAMLResponse is not a samlp:Response",
    );
  }

  // Status first: an IdP-side failure (user cancelled, no access, …) arrives
  // unsigned and without an assertion.
  const status = asNode(response.Status);
  const statusCode = asNode(status?.StatusCode);
  const code = attr(statusCode, "Value");
  if (code !== STATUS_SUCCESS) {
    const subCode = attr(asNode(statusCode?.StatusCode), "Value");
    const message = textOf(status?.StatusMessage) || undefined;
    throw new SamlResponseError(
      "idp_error",
      `Identity provider returned ${subCode || code || "no status"}${message ? `: ${message}` : ""}`,
      { code, subCode, message },
    );
  }

  if (asNodes(response.EncryptedAssertion).length > 0) {
    throw new SamlResponseError(
      "encrypted_assertion",
      "Encrypted assertions are not supported; turn off assertion encryption at the identity provider",
    );
  }

  const postedAssertions = asNodes(response.Assertion);
  if (postedAssertions.length !== 1) {
    throw new SamlResponseError(
      "invalid_response",
      `SAMLResponse must contain exactly one assertion, found ${postedAssertions.length}`,
    );
  }

  const certificates = params.idpCertificates
    .map((c) => normalizeCertificate(c))
    .filter((c): c is string => Boolean(c))
    .map((c) => certificateToPem(c));
  if (certificates.length === 0) {
    throw new SamlResponseError(
      "invalid_signature",
      "No identity provider signing certificate is configured",
    );
  }

  let signedReferences: string[];
  try {
    signedReferences = await params.verifier.verifySignedReferences(
      xml,
      certificates,
    );
  } catch (err) {
    throw new SamlResponseError(
      "invalid_signature",
      `SAMLResponse signature is invalid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Only the signed content is trusted from here on.
  let signedResponse: XmlNode | undefined;
  const signedAssertions = new Map<string, XmlNode>();
  for (const reference of signedReferences) {
    let fragment: XmlNode;
    try {
      fragment = parse(reference);
    } catch {
      continue;
    }
    const signedResponseNode = asNode(fragment.Response);
    if (signedResponseNode) {
      signedResponse = signedResponseNode;
      for (const a of asNodes(signedResponseNode.Assertion)) {
        const id = attr(a, "ID");
        if (id) signedAssertions.set(id, a);
      }
    }
    for (const a of asNodes(fragment.Assertion)) {
      const id = attr(a, "ID");
      if (id) signedAssertions.set(id, a);
    }
  }

  if (signedAssertions.size === 0) {
    throw new SamlResponseError(
      "unsigned",
      "Neither the SAMLResponse nor its assertion is signed",
    );
  }
  if (signedAssertions.size > 1) {
    throw new SamlResponseError(
      "invalid_response",
      "Signed content contains more than one assertion",
    );
  }
  const [[assertionId, assertion]] = [...signedAssertions.entries()] as [
    [string, XmlNode],
  ];
  if (attr(postedAssertions[0], "ID") !== assertionId) {
    throw new SamlResponseError(
      "invalid_response",
      "The signed assertion is not the assertion in the response",
    );
  }

  // Response-level Destination / InResponseTo: trusted only when signed, but
  // a mismatch in the unsigned envelope can only make the login fail.
  const envelope = signedResponse ?? response;
  const destination = attr(envelope, "Destination");
  if (
    destination &&
    !sameUrl(destination, params.assertionConsumerServiceUrl)
  ) {
    throw new SamlResponseError(
      "recipient_mismatch",
      `Response Destination ${destination} is not this connection's ACS URL`,
    );
  }
  const envelopeInResponseTo = attr(envelope, "InResponseTo");
  if (
    envelopeInResponseTo !== undefined &&
    envelopeInResponseTo !== params.inResponseTo
  ) {
    throw new SamlResponseError(
      "in_response_to_mismatch",
      "Response InResponseTo does not match the authentication request",
    );
  }

  const issuer = textOf(assertion.Issuer)?.trim() || undefined;
  if (params.idpEntityId && issuer !== params.idpEntityId) {
    throw new SamlResponseError(
      "issuer_mismatch",
      `Assertion Issuer ${issuer ?? "(none)"} is not the configured identity provider ${params.idpEntityId}`,
    );
  }

  const conditions = asNode(assertion.Conditions);
  const unknownCondition = Object.keys(conditions ?? {}).find(
    (key) =>
      !key.startsWith("@_") &&
      key !== "#text" &&
      !UNDERSTOOD_CONDITIONS.has(key),
  );
  if (unknownCondition) {
    throw new SamlResponseError(
      "invalid_response",
      `Assertion has a condition this service provider does not understand: ${unknownCondition}`,
    );
  }
  const notBefore = parseInstant(attr(conditions, "NotBefore"), "NotBefore");
  const notOnOrAfterAttr = attr(conditions, "NotOnOrAfter");
  const notOnOrAfter = parseInstant(notOnOrAfterAttr, "NotOnOrAfter");
  if (notBefore !== undefined && now + skew < notBefore) {
    throw new SamlResponseError("not_yet_valid", "Assertion is not yet valid");
  }
  if (notOnOrAfter !== undefined && now - skew >= notOnOrAfter) {
    throw new SamlResponseError("expired", "Assertion has expired");
  }

  const restrictions = asNodes(conditions?.AudienceRestriction);
  const audienceOk =
    restrictions.length > 0 &&
    restrictions.every((r) => {
      const audiences = Array.isArray(r.Audience) ? r.Audience : [r.Audience];
      return audiences.some((a) => textOf(a)?.trim() === params.spEntityId);
    });
  if (!audienceOk) {
    throw new SamlResponseError(
      "audience_mismatch",
      `Assertion audience does not include ${params.spEntityId}`,
    );
  }

  const subject = asNode(assertion.Subject);
  const nameIdNode = subject?.NameID;
  const nameId = textOf(nameIdNode)?.trim();
  if (!nameId) {
    throw new SamlResponseError(
      "missing_subject",
      "Assertion has no NameID (encrypted NameIDs are not supported)",
    );
  }

  // At least one bearer confirmation must hold (SAML Profiles §4.1.4.2).
  let confirmationError: SamlResponseError | undefined;
  let confirmedNotOnOrAfter: string | undefined;
  const confirmed = asNodes(subject?.SubjectConfirmation).some((sc) => {
    if (attr(sc, "Method") !== BEARER) return false;
    const data = asNode(sc.SubjectConfirmationData);
    const recipient = attr(data, "Recipient");
    const dataNotOnOrAfterAttr = attr(data, "NotOnOrAfter");
    const dataInResponseTo = attr(data, "InResponseTo");
    try {
      const dataNotOnOrAfter = parseInstant(
        dataNotOnOrAfterAttr,
        "SubjectConfirmationData NotOnOrAfter",
      );
      if (dataNotOnOrAfter === undefined || now - skew >= dataNotOnOrAfter) {
        throw new SamlResponseError(
          "expired",
          "Subject confirmation has expired",
        );
      }
      if (
        !recipient ||
        !sameUrl(recipient, params.assertionConsumerServiceUrl)
      ) {
        throw new SamlResponseError(
          "recipient_mismatch",
          `Subject confirmation Recipient ${recipient ?? "(none)"} is not this connection's ACS URL`,
        );
      }
      if (dataInResponseTo !== params.inResponseTo) {
        throw new SamlResponseError(
          "in_response_to_mismatch",
          params.inResponseTo
            ? "Assertion does not answer this authentication request"
            : "Unsolicited response refers to an authentication request",
        );
      }
    } catch (err) {
      if (err instanceof SamlResponseError) {
        confirmationError ??= err;
        return false;
      }
      throw err;
    }
    confirmedNotOnOrAfter = dataNotOnOrAfterAttr;
    return true;
  });
  if (!confirmed) {
    throw (
      confirmationError ??
      new SamlResponseError(
        "invalid_response",
        "Assertion has no bearer subject confirmation",
      )
    );
  }

  // The Web Browser SSO profile requires an authentication statement.
  const authnStatement = asNodes(assertion.AuthnStatement)[0];
  if (!authnStatement) {
    throw new SamlResponseError(
      "invalid_response",
      "Assertion has no AuthnStatement",
    );
  }
  const sessionNotOnOrAfter = parseInstant(
    attr(authnStatement, "SessionNotOnOrAfter"),
    "SessionNotOnOrAfter",
  );
  if (sessionNotOnOrAfter !== undefined && now - skew >= sessionNotOnOrAfter) {
    throw new SamlResponseError(
      "expired",
      "Authentication session has expired",
    );
  }

  return {
    assertionId,
    issuer,
    nameId,
    nameIdFormat: attr(asNode(nameIdNode), "Format"),
    sessionIndex: attr(authnStatement, "SessionIndex"),
    authnInstant: attr(authnStatement, "AuthnInstant"),
    inResponseTo: params.inResponseTo,
    attributes: collectAttributes(assertion),
    notOnOrAfter: confirmedNotOnOrAfter ?? notOnOrAfterAttr,
  };
}
