import { beforeAll, describe, expect, it } from "vitest";
import * as x509 from "@peculiar/x509";
import { SignedXml } from "xml-crypto";
import { XMLParser } from "fast-xml-parser";
import {
  certificateToPem,
  createRedirectBindingUrl,
  createSamlAuthnRequest,
  createSamlSpMetadata,
  normalizeCertificate,
  parseSamlIdpMetadata,
  selectSamlEndpoint,
  SAML_BINDING_HTTP_POST,
  SAML_BINDING_HTTP_REDIRECT,
} from "../src/sp";
import { SamlResponseError, validateSamlResponse } from "../src/response";
import {
  parseSamlAuthnRequest,
  verifyRedirectBindingSignature,
} from "../src/idp";
import { LocalSamlVerifier } from "../src/verifiers/local";
import { inflateDecompress } from "../src/helpers";

const IDP = "https://idp.example.com/metadata";
const SP = "urn:auth0:tenant:okta";
const ACS = "https://auth.example.com/login/callback?connection=okta";
const REQUEST_ID = "_req1";

interface KeyMaterial {
  privateKeyPem: string;
  certPem: string;
  certDer: string;
  publicKey: CryptoKey;
}

async function createKeyMaterial(name: string): Promise<KeyMaterial> {
  const alg = {
    name: "RSASSA-PKCS1-v1_5",
    hash: "SHA-256",
    publicExponent: new Uint8Array([1, 0, 1]),
    modulusLength: 2048,
  };
  const keys = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: `CN=${name}`,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 86_400_000),
    signingAlgorithm: alg,
    keys,
  });
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", keys.privateKey),
  );
  const b64 = Buffer.from(pkcs8).toString("base64");
  const lines = b64.match(/.{1,64}/g)!.join("\n");
  return {
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`,
    certPem: cert.toString("pem"),
    certDer: cert.toString("base64"),
    publicKey: keys.publicKey,
  };
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

interface ResponseOptions {
  inResponseTo?: string | null;
  recipient?: string;
  audience?: string;
  issuer?: string;
  nameId?: string;
  notBefore?: string;
  notOnOrAfter?: string;
  confirmationNotOnOrAfter?: string;
  status?: string;
  extraAssertion?: string;
  assertionId?: string;
  extraConditions?: string;
  omitAuthnStatement?: boolean;
  extraAttributes?: string;
}

function buildAssertion(o: ResponseOptions = {}) {
  const inResponseTo =
    o.inResponseTo === null
      ? ""
      : ` InResponseTo="${o.inResponseTo ?? REQUEST_ID}"`;
  return (
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${o.assertionId ?? "_a1"}" Version="2.0" IssueInstant="${iso(0)}">` +
    `<saml:Issuer>${o.issuer ?? IDP}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${o.nameId ?? "jane@example.com"}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData${inResponseTo} NotOnOrAfter="${o.confirmationNotOnOrAfter ?? iso(300_000)}" Recipient="${o.recipient ?? ACS}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${o.notBefore ?? iso(-60_000)}" NotOnOrAfter="${o.notOnOrAfter ?? iso(300_000)}"><saml:AudienceRestriction><saml:Audience>${o.audience ?? SP}</saml:Audience></saml:AudienceRestriction>${o.extraConditions ?? ""}</saml:Conditions>` +
    (o.omitAuthnStatement
      ? ""
      : `<saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="_sess1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>`) +
    `<saml:AttributeStatement>` +
    `<saml:Attribute Name="http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"><saml:AttributeValue>jane@example.com</saml:AttributeValue></saml:Attribute>` +
    `<saml:Attribute Name="groups"><saml:AttributeValue>admins</saml:AttributeValue><saml:AttributeValue>staff</saml:AttributeValue></saml:Attribute>` +
    `<saml:Attribute Name="employeeNumber"><saml:AttributeValue xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xs:string">00123</saml:AttributeValue></saml:Attribute>` +
    (o.extraAttributes ?? "") +
    `</saml:AttributeStatement>` +
    `</saml:Assertion>`
  );
}

function wrapResponse(assertion: string, o: ResponseOptions = {}) {
  const inResponseTo =
    o.inResponseTo === null
      ? ""
      : ` InResponseTo="${o.inResponseTo ?? REQUEST_ID}"`;
  return (
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_resp1" Version="2.0" IssueInstant="${iso(0)}" Destination="${ACS}"${inResponseTo}>` +
    `<saml:Issuer>${o.issuer ?? IDP}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="${o.status ?? "urn:oasis:names:tc:SAML:2.0:status:Success"}"/></samlp:Status>` +
    assertion +
    (o.extraAssertion ?? "") +
    `</samlp:Response>`
  );
}

function sign(xml: string, key: KeyMaterial, target: "assertion" | "response") {
  const sig = new SignedXml({
    privateKey: key.privateKeyPem,
    publicCert: key.certPem,
  });
  sig.canonicalizationAlgorithm = "http://www.w3.org/2001/10/xml-exc-c14n#";
  sig.signatureAlgorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
  const element =
    target === "assertion"
      ? "//*[local-name()='Assertion']"
      : "/*[local-name()='Response']";
  sig.addReference({
    xpath: element,
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
  });
  sig.computeSignature(xml, {
    location: {
      reference: `${element}/*[local-name()='Issuer']`,
      action: "after",
    },
  });
  return sig.getSignedXml();
}

const b64 = (xml: string) => Buffer.from(xml, "utf8").toString("base64");

describe("SAML service provider", () => {
  let idpKey: KeyMaterial;
  let otherKey: KeyMaterial;
  const verifier = new LocalSamlVerifier();

  beforeAll(async () => {
    idpKey = await createKeyMaterial("idp");
    otherKey = await createKeyMaterial("other");
  });

  const validate = (
    samlResponse: string,
    overrides: Partial<Parameters<typeof validateSamlResponse>[0]> = {},
  ) =>
    validateSamlResponse({
      samlResponse,
      verifier,
      idpCertificates: [idpKey.certDer],
      spEntityId: SP,
      assertionConsumerServiceUrl: ACS,
      inResponseTo: REQUEST_ID,
      idpEntityId: IDP,
      ...overrides,
    });

  const expectCode = async (promise: Promise<unknown>, code: string) => {
    await expect(promise).rejects.toBeInstanceOf(SamlResponseError);
    await expect(promise).rejects.toMatchObject({ code });
  };

  describe("validateSamlResponse", () => {
    it("accepts a response whose assertion is signed", async () => {
      const signed = sign(wrapResponse(buildAssertion()), idpKey, "assertion");
      const result = await validate(b64(signed));

      expect(result).toMatchObject({
        assertionId: "_a1",
        issuer: IDP,
        nameId: "jane@example.com",
        nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
        sessionIndex: "_sess1",
        inResponseTo: REQUEST_ID,
      });
      expect(result.attributes).toEqual({
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress":
          "jane@example.com",
        groups: ["admins", "staff"],
        employeeNumber: "00123",
      });
    });

    it("accepts a response signed only at the Response level", async () => {
      const signed = sign(wrapResponse(buildAssertion()), idpKey, "response");
      const result = await validate(b64(signed));
      expect(result.nameId).toBe("jane@example.com");
    });

    it("accepts a response signed at both levels", async () => {
      const assertionSigned = sign(
        wrapResponse(buildAssertion()),
        idpKey,
        "assertion",
      );
      const signed = sign(assertionSigned, idpKey, "response");
      const result = await validate(b64(signed));
      expect(result.nameId).toBe("jane@example.com");
    });

    it("trusts any of several configured certificates (rotation)", async () => {
      const signed = sign(wrapResponse(buildAssertion()), idpKey, "assertion");
      const result = await validate(b64(signed), {
        idpCertificates: [otherKey.certPem, idpKey.certPem],
      });
      expect(result.nameId).toBe("jane@example.com");
    });

    it("rejects an unsigned response", async () => {
      await expectCode(
        validate(b64(wrapResponse(buildAssertion()))),
        "unsigned",
      );
    });

    it("rejects a response signed by another key", async () => {
      const signed = sign(
        wrapResponse(buildAssertion()),
        otherKey,
        "assertion",
      );
      await expectCode(validate(b64(signed)), "invalid_signature");
    });

    it("rejects a tampered assertion", async () => {
      const signed = sign(wrapResponse(buildAssertion()), idpKey, "assertion");
      const tampered = signed.replace(
        ">jane@example.com</saml:NameID>",
        ">admin@example.com</saml:NameID>",
      );
      await expectCode(validate(b64(tampered)), "invalid_signature");
    });

    it("rejects a second, unsigned assertion next to the signed one", async () => {
      // Sign a response with one assertion, then add the unsigned sibling.
      const signed = sign(
        wrapResponse(buildAssertion()),
        idpKey,
        "assertion",
      ).replace(
        "</samlp:Response>",
        `${buildAssertion({ assertionId: "_evil", nameId: "admin@example.com" })}</samlp:Response>`,
      );
      const promise = validate(b64(signed));
      await expectCode(promise, "invalid_response");
      await expect(promise).rejects.toThrow(/exactly one assertion, found 2/);
    });

    it("never reads the assertion from unsigned content (signature wrapping)", async () => {
      const signed = sign(wrapResponse(buildAssertion()), idpKey, "assertion");
      const signedAssertion = signed.match(
        /<saml:Assertion[\s\S]*<\/saml:Assertion>/,
      )![0];
      // Move the genuine signed assertion out of the way and put a forged one
      // where an SP that reads the document would look.
      const wrapped = wrapResponse(
        buildAssertion({ assertionId: "_evil", nameId: "admin@example.com" }),
      ).replace(
        "<samlp:Status>",
        `<samlp:Extensions>${signedAssertion}</samlp:Extensions><samlp:Status>`,
      );
      await expectCode(validate(b64(wrapped)), "invalid_response");
    });

    it("reads the full NameID across an injected comment", async () => {
      const signed = sign(
        wrapResponse(buildAssertion({ nameId: "jane@example.com.evil.com" })),
        idpKey,
        "assertion",
      );
      // exc-c14n drops comments, so the signature still validates.
      const injected = signed.replace(
        "jane@example.com.evil.com",
        "jane@example.com<!---->.evil.com",
      );
      const result = await validate(b64(injected));
      expect(result.nameId).toBe("jane@example.com.evil.com");
    });

    it("rejects the wrong audience", async () => {
      const signed = sign(
        wrapResponse(buildAssertion({ audience: "urn:other-sp" })),
        idpKey,
        "assertion",
      );
      await expectCode(validate(b64(signed)), "audience_mismatch");
    });

    it("rejects the wrong recipient", async () => {
      const signed = sign(
        wrapResponse(
          buildAssertion({ recipient: "https://evil.example.com/acs" }),
        ),
        idpKey,
        "assertion",
      );
      await expectCode(validate(b64(signed)), "recipient_mismatch");
    });

    it("rejects an answer to another request", async () => {
      // The envelope matches; only the signed confirmation answers _other.
      const signed = sign(
        wrapResponse(buildAssertion({ inResponseTo: "_other" })),
        idpKey,
        "assertion",
      );
      const promise = validate(b64(signed));
      await expectCode(promise, "in_response_to_mismatch");
      await expect(promise).rejects.toThrow(
        /does not answer this authentication request/,
      );
    });

    it("rejects conditions it does not understand, accepts OneTimeUse", async () => {
      const unknown = sign(
        wrapResponse(
          buildAssertion({
            extraConditions: `<saml:Condition xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="ext:Custom"/>`,
          }),
        ),
        idpKey,
        "assertion",
      );
      const promise = validate(b64(unknown));
      await expectCode(promise, "invalid_response");
      await expect(promise).rejects.toThrow(/does not understand: Condition/);

      const oneTimeUse = sign(
        wrapResponse(buildAssertion({ extraConditions: `<saml:OneTimeUse/>` })),
        idpKey,
        "assertion",
      );
      await expect(validate(b64(oneTimeUse))).resolves.toBeDefined();
    });

    it('refuses ProxyRestriction Count="0" and accepts a positive count', async () => {
      const proxy = (count: string) =>
        sign(
          wrapResponse(
            buildAssertion({
              extraConditions: `<saml:ProxyRestriction Count="${count}"/>`,
            }),
          ),
          idpKey,
          "assertion",
        );
      const promise = validate(b64(proxy("0")));
      await expectCode(promise, "invalid_response");
      await expect(promise).rejects.toThrow(/ProxyRestriction/);
      await expect(validate(b64(proxy("1")))).resolves.toBeDefined();
    });

    it("requires an AuthnStatement", async () => {
      const signed = sign(
        wrapResponse(buildAssertion({ omitAuthnStatement: true })),
        idpKey,
        "assertion",
      );
      const promise = validate(b64(signed));
      await expectCode(promise, "invalid_response");
      await expect(promise).rejects.toThrow(/no AuthnStatement/);
    });

    it("keeps attribute names like toString and __proto__ as plain values", async () => {
      const signed = sign(
        wrapResponse(
          buildAssertion({
            extraAttributes:
              `<saml:Attribute Name="toString"><saml:AttributeValue>display</saml:AttributeValue></saml:Attribute>` +
              `<saml:Attribute Name="__proto__"><saml:AttributeValue>polluted</saml:AttributeValue></saml:Attribute>`,
          }),
        ),
        idpKey,
        "assertion",
      );
      const { attributes } = await validate(b64(signed));
      expect(
        Object.getOwnPropertyDescriptor(attributes, "toString")?.value,
      ).toBe("display");
      expect(
        Object.getOwnPropertyDescriptor(attributes, "__proto__")?.value,
      ).toBe("polluted");
      expect(Object.getPrototypeOf(attributes)).toBe(Object.prototype);
    });

    it("rejects an unsolicited response in an SP-initiated flow", async () => {
      const signed = sign(
        wrapResponse(buildAssertion({ inResponseTo: null }), {
          inResponseTo: null,
        }),
        idpKey,
        "assertion",
      );
      await expectCode(validate(b64(signed)), "in_response_to_mismatch");
    });

    it("accepts an unsolicited response when no request is expected", async () => {
      const signed = sign(
        wrapResponse(buildAssertion({ inResponseTo: null }), {
          inResponseTo: null,
        }),
        idpKey,
        "assertion",
      );
      const result = await validate(b64(signed), { inResponseTo: undefined });
      expect(result.nameId).toBe("jane@example.com");
    });

    it("rejects an expired assertion", async () => {
      const signed = sign(
        wrapResponse(
          buildAssertion({
            notOnOrAfter: iso(-600_000),
            confirmationNotOnOrAfter: iso(-600_000),
          }),
        ),
        idpKey,
        "assertion",
      );
      await expectCode(validate(b64(signed)), "expired");
    });

    it("tolerates clock skew but not a future assertion", async () => {
      const slightlyAhead = sign(
        wrapResponse(buildAssertion({ notBefore: iso(60_000) })),
        idpKey,
        "assertion",
      );
      await expect(validate(b64(slightlyAhead))).resolves.toBeDefined();

      const future = sign(
        wrapResponse(buildAssertion({ notBefore: iso(600_000) })),
        idpKey,
        "assertion",
      );
      await expectCode(validate(b64(future)), "not_yet_valid");
    });

    it("rejects another issuer", async () => {
      const signed = sign(
        wrapResponse(buildAssertion({ issuer: "https://other-idp" })),
        idpKey,
        "assertion",
      );
      await expectCode(validate(b64(signed)), "issuer_mismatch");
    });

    it("surfaces an IdP error status", async () => {
      const response =
        `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_r" Version="2.0" IssueInstant="${iso(0)}" InResponseTo="${REQUEST_ID}">` +
        `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Responder"><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:AuthnFailed"/></samlp:StatusCode><samlp:StatusMessage>User cancelled</samlp:StatusMessage></samlp:Status>` +
        `</samlp:Response>`;
      const promise = validate(b64(response));
      await expectCode(promise, "idp_error");
      await expect(promise).rejects.toMatchObject({
        status: {
          subCode: "urn:oasis:names:tc:SAML:2.0:status:AuthnFailed",
          message: "User cancelled",
        },
      });
    });

    it("rejects encrypted assertions with a clear error", async () => {
      const response = wrapResponse("").replace(
        "</samlp:Response>",
        `<saml:EncryptedAssertion><xenc:EncryptedData xmlns:xenc="http://www.w3.org/2001/04/xmlenc#"/></saml:EncryptedAssertion></samlp:Response>`,
      );
      await expectCode(validate(b64(response)), "encrypted_assertion");
    });

    it("rejects a DOCTYPE", async () => {
      const signed = sign(wrapResponse(buildAssertion()), idpKey, "assertion");
      const withDoctype = `<!DOCTYPE r [<!ENTITY x "y">]>${signed}`;
      await expectCode(validate(b64(withDoctype)), "invalid_response");
    });
  });

  describe("AuthnRequest", () => {
    it("builds a request for the ACS with HTTP-POST response binding", () => {
      const { id, xml } = createSamlAuthnRequest({
        destination: "https://idp.example.com/sso",
        issuer: SP,
        assertionConsumerServiceUrl: ACS,
      });
      expect(id).toMatch(/^_/);
      const parsed = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        removeNSPrefix: true,
      }).parse(xml);
      expect(parsed.AuthnRequest).toMatchObject({
        "@_ID": id,
        "@_Destination": "https://idp.example.com/sso",
        "@_AssertionConsumerServiceURL": ACS,
        "@_ProtocolBinding": SAML_BINDING_HTTP_POST,
        Issuer: SP,
      });
    });

    it("encodes an unsigned redirect and keeps existing query params", async () => {
      const { xml } = createSamlAuthnRequest({
        destination: "https://idp.example.com/sso?idpid=abc",
        issuer: SP,
        assertionConsumerServiceUrl: ACS,
      });
      const url = new URL(
        await createRedirectBindingUrl({
          endpoint: "https://idp.example.com/sso?idpid=abc",
          xml,
          relayState: "state-1",
        }),
      );
      expect(url.searchParams.get("idpid")).toBe("abc");
      expect(url.searchParams.get("RelayState")).toBe("state-1");
      expect(url.searchParams.get("Signature")).toBeNull();
      expect(
        await inflateDecompress(url.searchParams.get("SAMLRequest")!),
      ).toBe(xml);
    });

    it("puts the SAML parameters ahead of a fragment", async () => {
      const url = new URL(
        await createRedirectBindingUrl({
          endpoint: "https://idp.example.com/sso?tenant=alpha#login",
          xml: "<samlp:AuthnRequest/>",
          relayState: "rs",
        }),
      );
      expect(url.searchParams.get("tenant")).toBe("alpha");
      expect(url.searchParams.get("SAMLRequest")).toBeTruthy();
      expect(url.searchParams.get("RelayState")).toBe("rs");
      expect(url.hash).toBe("#login");
    });

    it("signs the redirect query string with the SP key", async () => {
      const { xml } = createSamlAuthnRequest({
        destination: "https://idp.example.com/sso",
        issuer: SP,
        assertionConsumerServiceUrl: ACS,
      });
      const url = await createRedirectBindingUrl({
        endpoint: "https://idp.example.com/sso",
        xml,
        relayState: "state-1",
        signingKey: { privateKeyPem: idpKey.privateKeyPem },
      });
      const query = url.split("?")[1]!;
      const signedPart = query.slice(0, query.indexOf("&Signature="));
      expect(signedPart).toMatch(/^SAMLRequest=.+&RelayState=state-1&SigAlg=/);
      const signature = Buffer.from(
        decodeURIComponent(query.slice(query.indexOf("&Signature=") + 11)),
        "base64",
      );
      const valid = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        idpKey.publicKey,
        signature,
        new TextEncoder().encode(signedPart),
      );
      expect(valid).toBe(true);
    });
  });

  describe("metadata", () => {
    const metadata = (cert: string) =>
      `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${IDP}">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>
${cert}
    </ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:KeyDescriptor use="encryption"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>ENCRYPTIONCERT</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:SingleLogoutService Binding="${SAML_BINDING_HTTP_REDIRECT}" Location="https://idp.example.com/slo"/>
    <md:SingleSignOnService Binding="${SAML_BINDING_HTTP_POST}" Location="https://idp.example.com/sso/post"/>
    <md:SingleSignOnService Binding="${SAML_BINDING_HTTP_REDIRECT}" Location="https://idp.example.com/sso/redirect"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

    it("parses IdP metadata", () => {
      const parsed = parseSamlIdpMetadata(metadata(idpKey.certDer));
      expect(parsed.entityId).toBe(IDP);
      expect(parsed.signingCertificates).toEqual([idpKey.certDer]);
      expect(selectSamlEndpoint(parsed.singleSignOnServices)?.location).toBe(
        "https://idp.example.com/sso/redirect",
      );
      expect(
        selectSamlEndpoint(parsed.singleSignOnServices, SAML_BINDING_HTTP_POST)
          ?.location,
      ).toBe("https://idp.example.com/sso/post");
      expect(parsed.singleLogoutServices).toEqual([
        {
          binding: SAML_BINDING_HTTP_REDIRECT,
          location: "https://idp.example.com/slo",
        },
      ]);
    });

    it("finds the IdP inside an EntitiesDescriptor", () => {
      const xml = `<EntitiesDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata">${metadata(
        idpKey.certDer,
      )
        .replace('<?xml version="1.0"?>', "")
        .replace(/md:/g, "")}</EntitiesDescriptor>`;
      expect(parseSamlIdpMetadata(xml).entityId).toBe(IDP);
    });

    it("finds the IdP in nested EntitiesDescriptor groups", () => {
      const entity = metadata(idpKey.certDer)
        .replace('<?xml version="1.0"?>', "")
        .replace(/md:/g, "");
      const xml =
        `<EntitiesDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata">` +
        `<EntitiesDescriptor>${entity}</EntitiesDescriptor></EntitiesDescriptor>`;
      expect(parseSamlIdpMetadata(xml).entityId).toBe(IDP);
    });

    it("uses the SAML 2.0 role, not a SAML 1.x role listed first", () => {
      const xml = metadata(idpKey.certDer).replace(
        "<md:IDPSSODescriptor",
        `<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:1.1:protocol"><md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>SAML1CERT</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor><md:SingleSignOnService Binding="urn:mace:shibboleth:1.0:profiles:AuthnRequest" Location="https://idp.example.com/saml1"/></md:IDPSSODescriptor><md:IDPSSODescriptor`,
      );
      const parsed = parseSamlIdpMetadata(xml);
      expect(parsed.signingCertificates).toEqual([idpKey.certDer]);
      expect(selectSamlEndpoint(parsed.singleSignOnServices)?.location).toBe(
        "https://idp.example.com/sso/redirect",
      );
    });

    it("rejects metadata without an IdP", () => {
      expect(() =>
        parseSamlIdpMetadata(
          `<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="sp"><SPSSODescriptor/></EntityDescriptor>`,
        ),
      ).toThrow(/identity provider/);
    });

    it("builds SP metadata", () => {
      const xml = createSamlSpMetadata({
        entityId: SP,
        assertionConsumerServiceUrl: ACS,
        signingCertificates: [idpKey.certDer],
        authnRequestsSigned: true,
      });
      const parsed = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
      }).parse(xml);
      expect(parsed.EntityDescriptor["@_entityID"]).toBe(SP);
      const sp = parsed.EntityDescriptor.SPSSODescriptor;
      expect(sp["@_AuthnRequestsSigned"]).toBe("true");
      expect(sp["@_WantAssertionsSigned"]).toBe("true");
      expect(sp.AssertionConsumerService["@_Location"]).toBe(ACS);
      expect(sp.KeyDescriptor.KeyInfo.X509Data.X509Certificate).toBe(
        idpKey.certDer,
      );
    });
  });

  describe("normalizeCertificate", () => {
    it("accepts PEM, base64 DER and base64 PEM", () => {
      expect(normalizeCertificate(idpKey.certPem)).toBe(idpKey.certDer);
      expect(normalizeCertificate(idpKey.certDer)).toBe(idpKey.certDer);
      expect(
        normalizeCertificate(Buffer.from(idpKey.certPem).toString("base64")),
      ).toBe(idpKey.certDer);
      expect(normalizeCertificate(certificateToPem(idpKey.certDer))).toBe(
        idpKey.certDer,
      );
    });

    it("accepts a PEM with literal \\n escapes from a JSON string", () => {
      const escaped = idpKey.certPem.trim().replace(/\n/g, "\\n");
      expect(escaped).toContain("\\n");
      expect(normalizeCertificate(escaped)).toBe(idpKey.certDer);
    });

    it("rejects garbage", () => {
      expect(
        normalizeCertificate(
          "-----BEGIN CERTIFICATE-----\nnot base64!\n-----END CERTIFICATE-----",
        ),
      ).toBeUndefined();
      expect(
        normalizeCertificate(
          "-----BEGIN CERTIFICATE-----\naGVsbG8=\n-----END CERTIFICATE-----",
        ),
      ).toBeUndefined();
      expect(normalizeCertificate("not a cert")).toBeUndefined();
      expect(normalizeCertificate("")).toBeUndefined();
      expect(normalizeCertificate("aGVsbG8=")).toBeUndefined();
    });
  });
});

describe("SAML identity provider helpers", () => {
  it("parses AuthnRequests regardless of namespace prefix", () => {
    const xml =
      `<saml2p:AuthnRequest xmlns:saml2p="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion" ID="_r9" Version="2.0" IssueInstant="2026-01-01T00:00:00Z" Destination="https://idp/sso" AssertionConsumerServiceURL="https://sp/acs" ForceAuthn="TRUE">` +
      `<saml2:Issuer>https://sp/entity</saml2:Issuer></saml2p:AuthnRequest>`;
    expect(parseSamlAuthnRequest(xml)).toEqual({
      id: "_r9",
      issuer: "https://sp/entity",
      assertionConsumerServiceUrl: "https://sp/acs",
      destination: "https://idp/sso",
      protocolBinding: undefined,
      issueInstant: "2026-01-01T00:00:00Z",
      forceAuthn: true,
    });
    expect(() =>
      parseSamlAuthnRequest(
        `<AuthnRequest xmlns="urn:oasis:names:tc:SAML:2.0:protocol" Version="2.0"/>`,
      ),
    ).toThrow(/no ID/);
    expect(() => parseSamlAuthnRequest(`<LogoutRequest ID="x"/>`)).toThrow(
      /not an AuthnRequest/,
    );
    const forceAuthn = (value: string) =>
      parseSamlAuthnRequest(
        `<AuthnRequest xmlns="urn:oasis:names:tc:SAML:2.0:protocol" ID="_x" ForceAuthn="${value}"/>`,
      ).forceAuthn;
    expect(forceAuthn("1")).toBe(true);
    expect(forceAuthn("true")).toBe(true);
    expect(forceAuthn("0")).toBe(false);
    expect(forceAuthn("false")).toBe(false);
  });

  describe("verifyRedirectBindingSignature", () => {
    let key: KeyMaterial;
    let spki: Uint8Array;
    let otherSpki: Uint8Array;

    beforeAll(async () => {
      key = await createKeyMaterial("sp");
      spki = new Uint8Array(
        await crypto.subtle.exportKey("spki", key.publicKey),
      );
      const other = await createKeyMaterial("other-sp");
      otherSpki = new Uint8Array(
        await crypto.subtle.exportKey("spki", other.publicKey),
      );
    });

    async function signedQuery(relayState?: string) {
      const url = await createRedirectBindingUrl({
        endpoint: "https://idp.example.com/samlp/client",
        xml: "<samlp:AuthnRequest/>",
        relayState,
        signingKey: { privateKeyPem: key.privateKeyPem },
      });
      return url.split("?")[1]!;
    }

    it("accepts a valid signature, with and without RelayState", async () => {
      for (const relayState of ["state/with spaces&more", undefined]) {
        const rawQuery = await signedQuery(relayState);
        expect(
          await verifyRedirectBindingSignature({
            rawQuery,
            parameter: "SAMLRequest",
            spkiKeys: [otherSpki, spki],
          }),
        ).toBe(true);
      }
    });

    it("skips keys that are not RSA keys", async () => {
      const ec = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        true,
        ["sign", "verify"],
      );
      const ecSpki = new Uint8Array(
        await crypto.subtle.exportKey("spki", ec.publicKey),
      );
      expect(
        await verifyRedirectBindingSignature({
          rawQuery: await signedQuery("state"),
          parameter: "SAMLRequest",
          spkiKeys: [ecSpki, spki],
        }),
      ).toBe(true);
    });

    it("rejects another key and a tampered query", async () => {
      const rawQuery = await signedQuery("state");
      expect(
        await verifyRedirectBindingSignature({
          rawQuery,
          parameter: "SAMLRequest",
          spkiKeys: [otherSpki],
        }),
      ).toBe(false);
      expect(
        await verifyRedirectBindingSignature({
          rawQuery: rawQuery.replace("RelayState=state", "RelayState=other"),
          parameter: "SAMLRequest",
          spkiKeys: [spki],
        }),
      ).toBe(false);
    });

    it("throws on unsigned, unsupported or ambiguous queries", async () => {
      const rawQuery = await signedQuery("state");
      const unsigned = rawQuery.slice(0, rawQuery.indexOf("&SigAlg="));
      await expect(
        verifyRedirectBindingSignature({
          rawQuery: unsigned,
          parameter: "SAMLRequest",
          spkiKeys: [spki],
        }),
      ).rejects.toThrow(/not signed/);
      await expect(
        verifyRedirectBindingSignature({
          rawQuery: rawQuery.replace(
            /SigAlg=[^&]+/,
            `SigAlg=${encodeURIComponent("http://www.w3.org/2000/09/xmldsig#hmac-sha1")}`,
          ),
          parameter: "SAMLRequest",
          spkiKeys: [spki],
        }),
      ).rejects.toThrow(/Unsupported SigAlg/);
      await expect(
        verifyRedirectBindingSignature({
          rawQuery: `${rawQuery}&SAMLRequest=other`,
          parameter: "SAMLRequest",
          spkiKeys: [spki],
        }),
      ).rejects.toThrow(/repeated/);
    });
  });
});
