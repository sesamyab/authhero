import { beforeAll, describe, expect, it } from "vitest";
import { SignedXml } from "xml-crypto";
import { XMLParser } from "fast-xml-parser";
import { createRedirectBindingUrl } from "@authhero/saml/core";
import { LocalSamlVerifier } from "@authhero/saml/local-verifier";
import { getTestServer } from "../../helpers/test-server";
import { createX509Certificate } from "../../../src/utils/encryption";

type SigningKey = Awaited<ReturnType<typeof createX509Certificate>>;

const SSO_URL = "http://localhost:3000/samlp/clientId";

function authnRequest(id = "_req1", acs = "https://example.com/callback") {
  return (
    `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="${SSO_URL}" AssertionConsumerServiceURL="${acs}">` +
    `<saml:Issuer>https://sp.example/sp</saml:Issuer>` +
    `</samlp:AuthnRequest>`
  );
}

function logoutRequest(sessionIndex: string) {
  return (
    `<samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_lr1" Version="2.0" IssueInstant="${new Date().toISOString()}">` +
    `<saml:Issuer>https://sp.example/sp</saml:Issuer>` +
    `<saml:NameID>foo@example.com</saml:NameID>` +
    `<samlp:SessionIndex>${sessionIndex}</samlp:SessionIndex>` +
    `</samlp:LogoutRequest>`
  );
}

function signXml(xml: string, key: SigningKey, root: string) {
  const sig = new SignedXml({ privateKey: key.pkcs7, publicCert: key.cert });
  sig.canonicalizationAlgorithm = "http://www.w3.org/2001/10/xml-exc-c14n#";
  sig.signatureAlgorithm = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
  sig.addReference({
    xpath: `/*[local-name()='${root}']`,
    digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
    transforms: [
      "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
      "http://www.w3.org/2001/10/xml-exc-c14n#",
    ],
  });
  sig.computeSignature(xml, {
    location: {
      reference: `/*[local-name()='${root}']/*[local-name()='Issuer']`,
      action: "after",
    },
  });
  return sig.getSignedXml();
}

async function redirectQuery(xml: string, key?: SigningKey, relayState = "rs") {
  const url = await createRedirectBindingUrl({
    endpoint: SSO_URL,
    xml,
    relayState,
    signingKey: key ? { privateKeyPem: key.pkcs7! } : undefined,
  });
  return url.slice(url.indexOf("?") + 1);
}

describe("SAML IdP: signed requests and the HTTP-POST binding", () => {
  let spKey: SigningKey;
  let otherKey: SigningKey;

  beforeAll(async () => {
    spKey = await createX509Certificate({ name: "CN=sp" });
    otherKey = await createX509Certificate({ name: "CN=other" });
  });

  async function setup(addon: Record<string, unknown> = {}) {
    const server = await getTestServer();
    server.env.samlVerifier = new LocalSamlVerifier();
    await server.env.data.clients.update("tenantId", "clientId", {
      addons: { samlp: addon },
    });
    const get = (query: string) =>
      server.samlApp.request(`/clientId?${query}`, {}, server.env);
    const post = (path: string, fields: Record<string, string>) =>
      server.samlApp.request(
        path,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(fields).toString(),
        },
        server.env,
      );
    return { ...server, get, post };
  }

  const b64 = (xml: string) => Buffer.from(xml, "utf8").toString("base64");

  it("accepts an AuthnRequest over the HTTP-POST binding", async () => {
    const { post } = await setup();
    const response = await post("/clientId", {
      SAMLRequest: b64(authnRequest()),
      RelayState: "rs",
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toMatch(
      /^\/u\/login\/identifier\?state=/,
    );
  });

  it("parses AuthnRequests with other namespace prefixes", async () => {
    const { post } = await setup();
    const xml = authnRequest()
      .replace(/samlp:/g, "saml2p:")
      .replace(/xmlns:samlp/g, "xmlns:saml2p")
      .replace(/saml:/g, "saml2:")
      .replace(/xmlns:saml=/g, "xmlns:saml2=");
    const response = await post("/clientId", { SAMLRequest: b64(xml) });
    expect(response.status).toBe(302);
  });

  describe("with the SP's signingCert on the addon", () => {
    it("accepts a correctly signed HTTP-Redirect request", async () => {
      const { get } = await setup({ signingCert: spKey.cert });
      const response = await get(await redirectQuery(authnRequest(), spKey));
      expect(response.status, await response.clone().text()).toBe(302);
    });

    it("rejects an unsigned, wrongly signed or tampered redirect request", async () => {
      const { get } = await setup({ signingCert: spKey.cert });

      for (const query of [
        await redirectQuery(authnRequest()),
        await redirectQuery(authnRequest(), otherKey),
        (await redirectQuery(authnRequest(), spKey)).replace(
          "RelayState=rs",
          "RelayState=changed",
        ),
      ]) {
        const response = await get(query);
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error_description).toMatch(/signature verification/);
      }
    });

    it("accepts a signed HTTP-POST request and rejects an unsigned one", async () => {
      const { post } = await setup({ signingCert: spKey.cert });

      const signed = await post("/clientId", {
        SAMLRequest: b64(signXml(authnRequest(), spKey, "AuthnRequest")),
      });
      expect(signed.status, await signed.clone().text()).toBe(302);

      const unsigned = await post("/clientId", {
        SAMLRequest: b64(authnRequest()),
      });
      expect(unsigned.status).toBe(400);
      expect((await unsigned.json()).error_description).toMatch(
        /signature verification failed/,
      );
    });

    it("rejects a signed request wrapped in an unsigned one", async () => {
      const { post } = await setup({ signingCert: spKey.cert });
      const genuine = signXml(authnRequest("_good"), spKey, "AuthnRequest");
      // A forged request for another ACS, carrying the genuine signed one.
      const wrapped = authnRequest(
        "_evil",
        "https://example.com/callback?evil",
      ).replace(
        "</saml:Issuer>",
        `</saml:Issuer><samlp:Extensions>${genuine}</samlp:Extensions>`,
      );
      const response = await post("/clientId", { SAMLRequest: b64(wrapped) });
      expect(response.status).toBe(400);
      expect((await response.json()).error_description).toBe(
        "SAMLRequest signature verification failed: the request is not signed",
      );
    });

    it("requires a signed LogoutRequest", async () => {
      const { env, samlApp } = await setup({
        signingCert: spKey.cert,
        logout: { callback: "https://sp.example/slo" },
      });
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      await env.data.sessions.create("tenantId", {
        id: "saml-sid",
        user_id: "email|userId",
        login_session_id: "ls",
        used_at: new Date().toISOString(),
        device: {},
        clients: ["clientId"],
        expires_at: expiresAt,
        idle_expires_at: expiresAt,
      });
      const logout = (query: string) =>
        samlApp.request(`/clientId/logout?${query}`, {}, env);

      const unsigned = await logout(
        await redirectQuery(logoutRequest("saml-sid")),
      );
      expect(
        new URL(unsigned.headers.get("location")!).searchParams.get(
          "SAMLResponse",
        ),
      ).toBeTruthy();
      expect(
        (await env.data.sessions.get("tenantId", "saml-sid"))?.revoked_at,
      ).toBeFalsy();

      const signed = await logout(
        await redirectQuery(logoutRequest("saml-sid"), spKey),
      );
      expect(signed.status).toBe(302);
      expect(
        (await env.data.sessions.get("tenantId", "saml-sid"))?.revoked_at,
      ).toBeTruthy();
    });
  });

  it("still fails closed on require_signed_requests without a certificate", async () => {
    const { get } = await setup({ require_signed_requests: true });
    const response = await get(await redirectQuery(authnRequest(), spKey));
    expect(response.status).toBe(400);
  });

  it("publishes the assertion Issuer as the IdP entity ID", async () => {
    const { samlApp, env } = await setup({ audience: "urn:sp:audience" });
    const key = await createX509Certificate({ name: "CN=saml" });
    await env.data.keys.create({ ...key, type: "saml_encryption" });
    const response = await samlApp.request("/metadata/clientId", {}, env);
    expect(response.status).toBe(200);
    const metadata = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
    }).parse(await response.text());
    expect(metadata.EntityDescriptor["@_entityID"]).toBe(env.ISSUER);
  });
});
