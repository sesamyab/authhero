import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testClient } from "hono/testing";
import * as x509 from "@peculiar/x509";
import { XMLParser } from "fast-xml-parser";
import { AuthorizationResponseType } from "@authhero/adapter-interfaces";
import { inflateDecompress } from "@authhero/saml/core";
import { LocalSamlSigner } from "@authhero/saml/local-signer";
import { LocalSamlVerifier } from "@authhero/saml/local-verifier";
import { getTestServer } from "../helpers/test-server";
import { getAdminToken } from "../helpers/token";
import { findHrdConnection } from "../../src/helpers/hrd";
import { createX509Certificate } from "../../src/utils/encryption";
import { mapSamlAssertion } from "../../src/strategies/samlp";
import type { Connection } from "@authhero/adapter-interfaces";

const IDP = "https://idp.example.com/metadata";
const SIGN_IN = "https://idp.example.com/sso";
const CONNECTION = "okta-saml";
const ACS = `http://localhost:3000/login/callback?connection=${CONNECTION}`;
const SP_ENTITY_ID = `urn:auth0:tenantId:${CONNECTION}`;

interface KeyMaterial {
  privateKeyPem: string;
  certPem: string;
  certDer: string;
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
  const pkcs8 = Buffer.from(
    await crypto.subtle.exportKey("pkcs8", keys.privateKey),
  ).toString("base64");
  return {
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${pkcs8.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`,
    certPem: cert.toString("pem"),
    certDer: cert.toString("base64"),
  };
}

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

function buildResponse(opts: {
  inResponseTo: string;
  status?: string;
  nameId?: string;
}) {
  const status = opts.status ?? "urn:oasis:names:tc:SAML:2.0:status:Success";
  const assertion =
    status === "urn:oasis:names:tc:SAML:2.0:status:Success"
      ? `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_a1" Version="2.0" IssueInstant="${iso(0)}">` +
        `<saml:Issuer>${IDP}</saml:Issuer>` +
        `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${opts.nameId ?? "jane@example.com"}</saml:NameID>` +
        `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${opts.inResponseTo}" NotOnOrAfter="${iso(300_000)}" Recipient="${ACS.replace(/&/g, "&amp;")}"/></saml:SubjectConfirmation></saml:Subject>` +
        `<saml:Conditions NotBefore="${iso(-60_000)}" NotOnOrAfter="${iso(300_000)}"><saml:AudienceRestriction><saml:Audience>${SP_ENTITY_ID}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
        `<saml:AuthnStatement AuthnInstant="${iso(0)}" SessionIndex="_sess1"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
        `<saml:AttributeStatement>` +
        `<saml:Attribute Name="http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname"><saml:AttributeValue>Jane</saml:AttributeValue></saml:Attribute>` +
        `<saml:Attribute Name="http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname"><saml:AttributeValue>Doe</saml:AttributeValue></saml:Attribute>` +
        `<saml:Attribute Name="groups"><saml:AttributeValue>admins</saml:AttributeValue><saml:AttributeValue>staff</saml:AttributeValue></saml:Attribute>` +
        `</saml:AttributeStatement>` +
        `</saml:Assertion>`
      : "";
  return (
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_resp1" Version="2.0" IssueInstant="${iso(0)}" InResponseTo="${opts.inResponseTo}">` +
    `<saml:Issuer>${IDP}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="${status}"/>${status.endsWith("Success") ? "" : "<samlp:StatusMessage>User cancelled</samlp:StatusMessage>"}</samlp:Status>` +
    assertion +
    `</samlp:Response>`
  );
}

async function signedResponse(
  key: KeyMaterial,
  opts: Parameters<typeof buildResponse>[0],
) {
  const signed = await new LocalSamlSigner().signSAML(
    buildResponse(opts),
    key.privateKeyPem,
    key.certPem,
  );
  return Buffer.from(signed, "utf8").toString("base64");
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
});

describe("samlp connections (AuthHero as SAML SP)", () => {
  let idpKey: KeyMaterial;
  let otherKey: KeyMaterial;

  beforeAll(async () => {
    idpKey = await createKeyMaterial("idp");
    otherKey = await createKeyMaterial("other");
  });

  async function setup(
    options: Record<string, unknown> = {},
    { verifier = true }: { verifier?: boolean } = {},
  ) {
    const server = await getTestServer();
    if (verifier) server.env.samlVerifier = new LocalSamlVerifier();
    await server.env.data.connections.create("tenantId", {
      id: "saml-okta",
      name: CONNECTION,
      strategy: "samlp",
      options: {
        signInEndpoint: SIGN_IN,
        signingCert: idpKey.certPem,
        issuer: IDP,
        ...options,
      },
    });
    return server;
  }

  async function startLogin(server: Awaited<ReturnType<typeof setup>>) {
    const oauthClient = testClient(server.oauthApp, server.env);
    const response = await oauthClient.authorize.$get(
      {
        query: {
          client_id: "clientId",
          redirect_uri: "https://example.com/callback",
          state: "state",
          connection: CONNECTION,
          response_type: AuthorizationResponseType.CODE,
        },
      },
      { headers: { origin: "https://example.com" } },
    );
    return response;
  }

  async function redirectLogin(server: Awaited<ReturnType<typeof setup>>) {
    const response = await startLogin(server);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    const relayState = location.searchParams.get("RelayState")!;
    const requestXml = await inflateDecompress(
      location.searchParams.get("SAMLRequest")!,
    );
    const request = parser.parse(requestXml).AuthnRequest;
    return { location, relayState, request };
  }

  async function lastFailureDescription(
    server: Awaited<ReturnType<typeof setup>>,
  ) {
    const { logs } = await server.env.data.logs.list("tenantId", {
      page: 0,
      per_page: 100,
      include_totals: false,
    });
    return logs
      .filter((l) => l.type === "f")
      .map((l) => l.description)
      .join("\n");
  }

  function postAcs(
    server: Awaited<ReturnType<typeof setup>>,
    fields: Record<string, string>,
  ) {
    return server.oauthApp.request(
      `/login/callback?connection=${CONNECTION}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields).toString(),
      },
      server.env,
    );
  }

  it("sends an AuthnRequest and logs the user in from a signed response", async () => {
    const server = await setup();
    const { location, relayState, request } = await redirectLogin(server);

    expect(`${location.origin}${location.pathname}`).toBe(SIGN_IN);
    expect(location.searchParams.get("Signature")).toBeNull();
    expect(request["@_AssertionConsumerServiceURL"]).toBe(ACS);
    expect(request["@_Destination"]).toBe(SIGN_IN);
    expect(request.Issuer).toBe(SP_ENTITY_ID);

    // The request id is kept with the state for the InResponseTo check.
    const stateCode = await server.env.data.codes.get(
      "tenantId",
      relayState,
      "oauth2_state",
    );
    expect(stateCode?.code_verifier).toBe(request["@_ID"]);

    const response = await postAcs(server, {
      SAMLResponse: await signedResponse(idpKey, {
        inResponseTo: request["@_ID"],
      }),
      RelayState: relayState,
    });
    expect(response.status, await response.clone().text()).toBe(302);
    expect(response.headers.get("location")).not.toContain("error");

    const user = await server.env.data.users.get(
      "tenantId",
      `samlp|${CONNECTION}|jane@example.com`,
    );
    expect(user).toMatchObject({
      email: "jane@example.com",
      given_name: "Jane",
      family_name: "Doe",
      provider: "samlp",
      connection: CONNECTION,
    });
    const profileData = JSON.parse(user!.profileData!);
    expect(profileData.groups).toEqual(["admins", "staff"]);
    expect(profileData.sessionIndex).toBe("_sess1");
  });

  it("refuses to replay a response", async () => {
    const server = await setup();
    const { relayState, request } = await redirectLogin(server);
    const fields = {
      SAMLResponse: await signedResponse(idpKey, {
        inResponseTo: request["@_ID"],
      }),
      RelayState: relayState,
    };

    const first = await postAcs(server, fields);
    expect(first.headers.get("location")).not.toContain("error");

    const replay = await postAcs(server, fields);
    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toContain(
      "/u2/error?error=state_not_found",
    );
  });

  it("rejects a response signed by another key", async () => {
    const server = await setup();
    const { relayState, request } = await redirectLogin(server);
    const response = await postAcs(server, {
      SAMLResponse: await signedResponse(otherKey, {
        inResponseTo: request["@_ID"],
      }),
      RelayState: relayState,
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      "error=connection_error",
    );
    expect(
      await server.env.data.users.get(
        "tenantId",
        `samlp|${CONNECTION}|jane@example.com`,
      ),
    ).toBeNull();
    expect(await lastFailureDescription(server)).toContain(
      "signature is invalid",
    );
  });

  it("rejects an answer to another AuthnRequest", async () => {
    const server = await setup();
    const { relayState } = await redirectLogin(server);
    const response = await postAcs(server, {
      SAMLResponse: await signedResponse(idpKey, { inResponseTo: "_other" }),
      RelayState: relayState,
    });
    expect(response.headers.get("location")).toContain(
      "error=connection_error",
    );
    expect(await lastFailureDescription(server)).toContain(
      "InResponseTo does not match",
    );
  });

  it("fails closed without a configured verifier", async () => {
    const server = await setup({}, { verifier: false });
    const { relayState, request } = await redirectLogin(server);
    const response = await postAcs(server, {
      SAMLResponse: await signedResponse(idpKey, {
        inResponseTo: request["@_ID"],
      }),
      RelayState: relayState,
    });
    expect(response.headers.get("location")).toContain(
      "error=connection_error",
    );
    expect(await lastFailureDescription(server)).toContain(
      "verification is not configured",
    );
  });

  it("reports an IdP error status as access_denied", async () => {
    const server = await setup();
    const { relayState, request } = await redirectLogin(server);
    const response = await postAcs(server, {
      SAMLResponse: Buffer.from(
        buildResponse({
          inResponseTo: request["@_ID"],
          status: "urn:oasis:names:tc:SAML:2.0:status:Responder",
        }),
      ).toString("base64"),
      RelayState: relayState,
    });
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("error_description")).toBe(
      "User cancelled",
    );
  });

  it("rejects IdP-initiated responses", async () => {
    const server = await setup();
    const response = await postAcs(server, {
      SAMLResponse: await signedResponse(idpKey, { inResponseTo: "_x" }),
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      "/u2/error?error=invalid_request",
    );
  });

  it("signs the AuthnRequest when signSAMLRequest is set", async () => {
    const server = await setup({ signSAMLRequest: true });
    // The test server has no SAML key yet.
    const samlKey = await createX509Certificate({ name: "CN=saml" });
    await server.env.data.keys.create({
      ...samlKey,
      type: "saml_encryption",
      tenant_id: "tenantId",
    });

    const { location } = await redirectLogin(server);
    expect(location.searchParams.get("SigAlg")).toBe(
      "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
    );
    expect(location.searchParams.get("Signature")).toBeTruthy();
  });

  it("uses an auto-submitting form for the HTTP-POST binding", async () => {
    const server = await setup({
      protocolBinding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
    });
    const response = await startLogin(server);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(`action="${SIGN_IN}"`);
    const samlRequest = html.match(/name="SAMLRequest" value="([^"]+)"/)![1]!;
    const xml = Buffer.from(samlRequest, "base64").toString("utf8");
    expect(
      parser.parse(xml).AuthnRequest["@_AssertionConsumerServiceURL"],
    ).toBe(ACS);
    expect(html).toMatch(/name="RelayState" value="[^"]+"/);
  });

  it("publishes SP metadata", async () => {
    const server = await setup();
    const response = await server.samlApp.request(
      `/metadata?connection=${CONNECTION}`,
      { headers: { "tenant-id": "tenantId" } },
      server.env,
    );
    expect(response.status).toBe(200);
    const metadata = parser.parse(await response.text()).EntityDescriptor;
    expect(metadata["@_entityID"]).toBe(SP_ENTITY_ID);
    expect(
      metadata.SPSSODescriptor.AssertionConsumerService["@_Location"],
    ).toBe(ACS);

    const missing = await server.samlApp.request(
      `/metadata?connection=nope`,
      { headers: { "tenant-id": "tenantId" } },
      server.env,
    );
    expect(missing.status).toBe(404);
  });

  it("takes part in home realm discovery", async () => {
    const server = await setup({ domain_aliases: ["example.org"] });
    const { connections } = await server.env.data.connections.list("tenantId");
    expect(findHrdConnection("jane@example.org", connections)?.name).toBe(
      CONNECTION,
    );
  });

  describe("user id mapping", () => {
    const assertion = {
      assertionId: "_a",
      nameId: "jane@example.com",
      nameIdFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
      attributes: { employeeId: "E42", upn: "jane@corp.example.com" },
    };
    const connectionWith = (options: Connection["options"]): Connection => ({
      id: "c",
      name: CONNECTION,
      strategy: "samlp",
      options,
      created_at: "",
      updated_at: "",
    });
    const subFor = (options: Connection["options"]) =>
      mapSamlAssertion(connectionWith(options), assertion).userinfo.sub;

    it("defaults to the NameID", () => {
      expect(subFor({})).toBe(`${CONNECTION}|jane@example.com`);
    });

    it("follows Auth0's fieldsMap.user_id, with the NameID as nameidentifier", () => {
      expect(
        subFor({ fieldsMap: { user_id: ["missing", "employeeId"] } }),
      ).toBe(`${CONNECTION}|E42`);
      expect(
        subFor({
          fieldsMap: {
            user_id: [
              "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier",
              "employeeId",
            ],
          },
        }),
      ).toBe(`${CONNECTION}|jane@example.com`);
    });

    it("prefers user_id_attribute and fails when the attribute is missing", () => {
      expect(
        subFor({
          user_id_attribute: "upn",
          fieldsMap: { user_id: "employeeId" },
        }),
      ).toBe(`${CONNECTION}|jane@corp.example.com`);
      expect(() => subFor({ fieldsMap: { user_id: "toString" } })).toThrow(
        /no value for the user id attribute/,
      );
    });
  });

  describe("management API", () => {
    const idpMetadata = (certDer: string) =>
      `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="${IDP}">` +
      `<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">` +
      `<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>${certDer}</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>` +
      `<md:SingleLogoutService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://idp.example.com/slo"/>` +
      `<md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${SIGN_IN}"/>` +
      `</md:IDPSSODescriptor></md:EntityDescriptor>`;

    const REDIRECT = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
    const POST = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";
    const POST_SIGN_IN = "https://idp.example.com/sso/post";
    const bothBindings = (certDer: string) =>
      idpMetadata(certDer).replace(
        "</md:IDPSSODescriptor>",
        `<md:SingleSignOnService Binding="${POST}" Location="${POST_SIGN_IN}"/></md:IDPSSODescriptor>`,
      );

    async function createConnection(options: Record<string, unknown>) {
      const { managementApp, env } = await getTestServer();
      const managementClient = testClient(managementApp, env);
      const token = await getAdminToken();
      return managementClient.connections.$post(
        {
          json: { name: "saml-from-metadata", strategy: "samlp", options },
          header: { "tenant-id": "tenantId" },
        },
        { headers: { authorization: `Bearer ${token}` } },
      );
    }

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("keeps the sign-in endpoint paired with a changed binding", async () => {
      const { managementApp, env } = await getTestServer();
      const managementClient = testClient(managementApp, env);
      const token = await getAdminToken();
      const auth = { headers: { authorization: `Bearer ${token}` } };
      const header = { "tenant-id": "tenantId" };

      const created = await managementClient.connections.$post(
        {
          json: {
            name: "saml-bindings",
            strategy: "samlp",
            options: { metadataXml: bothBindings(idpKey.certDer) },
          },
          header,
        },
        auth,
      );
      const connection = await created.json();
      expect(connection.options).toMatchObject({
        signInEndpoint: SIGN_IN,
        protocolBinding: REDIRECT,
      });

      // Resubmit the full options with only the binding changed.
      const patched = await managementClient.connections[":id"].$patch(
        {
          param: { id: connection.id },
          json: { options: { ...connection.options, protocolBinding: POST } },
          header,
        },
        auth,
      );
      expect(patched.status).toBe(200);
      expect((await patched.json()).options).toMatchObject({
        signInEndpoint: POST_SIGN_IN,
        protocolBinding: POST,
      });
    });

    it("rejects a binding the metadata does not offer", async () => {
      const response = await createConnection({
        metadataXml: idpMetadata(idpKey.certDer),
        protocolBinding: POST,
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("HTTP-POST binding");
    });

    it("rejects signed requests over HTTP-POST", async () => {
      const response = await createConnection({
        signInEndpoint: SIGN_IN,
        signingCert: idpKey.certPem,
        protocolBinding: POST,
        signSAMLRequest: true,
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("signSAMLRequest");
    });

    it("rejects an empty metadata download", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 204 })),
      );
      const response = await createConnection({
        metadataUrl: "https://idp.example.com/metadata",
      });
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("is empty");
    });

    it("rejects DER that is not an X.509 certificate", async () => {
      // A bare SEQUENCE: looks like DER, is no certificate.
      const response = await createConnection({
        signInEndpoint: SIGN_IN,
        signingCert: "MAMCAQA=",
      });
      expect(response.status).toBe(400);
    });

    it("fills the connection from metadataXml", async () => {
      const response = await createConnection({
        metadataXml: idpMetadata(idpKey.certDer),
      });
      expect(response.status).toBe(201);
      const connection = await response.json();
      expect(connection.options).toMatchObject({
        signInEndpoint: SIGN_IN,
        signOutEndpoint: "https://idp.example.com/slo",
        issuer: IDP,
        protocolBinding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect",
      });
      expect(connection.options.signingCert).toContain(
        "-----BEGIN CERTIFICATE-----",
      );
    });

    it("rejects invalid metadata and certificates", async () => {
      expect(
        (await createConnection({ metadataXml: "<not-metadata/>" })).status,
      ).toBe(400);
      expect(
        (
          await createConnection({
            signInEndpoint: SIGN_IN,
            signingCert: "not a certificate",
          })
        ).status,
      ).toBe(400);
    });
  });
});
