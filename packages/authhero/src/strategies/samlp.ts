/**
 * SAML 2.0 enterprise connections (`samlp`): AuthHero as the service
 * provider, federating to an upstream SAML identity provider (Okta, Entra ID,
 * ADFS, Google Workspace, …). Auth0-compatible endpoints:
 *
 * - ACS: `POST {authUrl}login/callback?connection={name}`
 * - SP metadata: `GET {authUrl}samlp/metadata?connection={name}`
 * - SP entity ID: `urn:auth0:{tenant_id}:{name}` (or `options.entityId`)
 *
 * The AuthnRequest's RelayState is the `oauth2_state` code and its ID is
 * stored as the code's `code_verifier`, so the response's InResponseTo is
 * checked against the request this login actually sent.
 */
import { Context } from "hono";
import { Connection, encodeBase64 } from "@authhero/adapter-interfaces";
import {
  createRedirectBindingUrl,
  createSamlAuthnRequest,
  SAML_BINDING_HTTP_POST,
  SamlAssertion,
  validateSamlResponse,
} from "@authhero/saml/core";
import { nanoid } from "nanoid";
import { Bindings, Variables } from "../types";
import { resolveSigningKeys } from "../helpers/signing-keys";
import { getConnectionCallbackUrl, UserInfo, UserInfoWithRaw } from "./index";

type Ctx = Context<{ Bindings: Bindings; Variables: Variables }>;

export const displayName = "SAML";

// A generic "enterprise" key icon.
export const logoDataUri =
  "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2245%22%20height%3D%2245%22%20viewBox%3D%220%200%2045%2045%22%3E%3Ccircle%20cx%3D%2215%22%20cy%3D%2222.5%22%20r%3D%227%22%20fill%3D%22none%22%20stroke%3D%22%23666%22%20stroke-width%3D%223%22%2F%3E%3Cpath%20d%3D%22M22%2022.5h17M33%2022.5v6M38%2022.5v4%22%20fill%3D%22none%22%20stroke%3D%22%23666%22%20stroke-width%3D%223%22%20stroke-linecap%3D%22round%22%2F%3E%3C%2Fsvg%3E";

/** The SP entity ID: the Audience the IdP must put in its assertions. */
export function getSamlSpEntityId(
  tenantId: string,
  connection: Connection,
): string {
  return (
    connection.options?.entityId || `urn:auth0:${tenantId}:${connection.name}`
  );
}

/**
 * The assertion consumer service URL registered at the IdP. An explicit
 * `options.callback_url` is used verbatim; otherwise it is Auth0's
 * `/login/callback?connection={name}` on the request's host.
 */
export function getSamlAcsUrl(ctx: Ctx, connection: Connection): string {
  if (connection.options?.callback_url) {
    return connection.options.callback_url;
  }
  const url = new URL(getConnectionCallbackUrl(ctx, connection));
  url.searchParams.set("connection", connection.name);
  return url.toString();
}

/** All trusted IdP signing certificates of the connection. */
export function getSamlIdpCertificates(connection: Connection): string[] {
  const { signingCert, signingCerts } = connection.options || {};
  return [...(signingCert ? [signingCert] : []), ...(signingCerts || [])];
}

function requireTenantId(ctx: Ctx): string {
  const tenantId = ctx.var.tenant_id;
  if (!tenantId) {
    throw new Error("SAML connections need a resolved tenant");
  }
  return tenantId;
}

export async function getRedirect(ctx: Ctx, connection: Connection) {
  const { options } = connection;
  if (!options?.signInEndpoint) {
    throw new Error(
      "SAML connection has no signInEndpoint; set it or provide metadataXml/metadataUrl",
    );
  }
  const tenantId = requireTenantId(ctx);

  const { id, xml } = createSamlAuthnRequest({
    destination: options.signInEndpoint,
    issuer: getSamlSpEntityId(tenantId, connection),
    assertionConsumerServiceUrl: getSamlAcsUrl(ctx, connection),
  });
  // The RelayState doubles as the `oauth2_state` code id.
  const relayState = nanoid();

  if (options.protocolBinding === SAML_BINDING_HTTP_POST) {
    if (options.signSAMLRequest) {
      throw new Error(
        "Signed AuthnRequests are only supported with the HTTP-Redirect binding",
      );
    }
    return {
      redirectUrl: options.signInEndpoint,
      code: relayState,
      codeVerifier: id,
      formPost: {
        SAMLRequest: encodeBase64(new TextEncoder().encode(xml)),
        RelayState: relayState,
      },
    };
  }

  let signingKey:
    | { privateKeyPem: string; algorithm?: "rsa-sha256" | "rsa-sha1" }
    | undefined;
  if (options.signSAMLRequest) {
    const [key] = await resolveSigningKeys(
      ctx.env.data.keys,
      tenantId,
      ctx.env.signingKeyMode,
      { purpose: "sign", type: "saml_encryption" },
    );
    if (!key?.pkcs7) {
      throw new Error("No SAML signing key found to sign the AuthnRequest");
    }
    signingKey = {
      privateKeyPem: key.pkcs7,
      algorithm: options.signatureAlgorithm,
    };
  }

  return {
    redirectUrl: await createRedirectBindingUrl({
      endpoint: options.signInEndpoint,
      xml,
      relayState,
      signingKey,
    }),
    code: relayState,
    codeVerifier: id,
  };
}

const CLAIMS = "http://schemas.xmlsoap.org/ws/2005/05/identity/claims";

// Profile field → SAML attribute names, first match wins. Covers the WS-Fed
// claim URIs (Entra ID, ADFS), the LDAP OIDs (Shibboleth, many SAML IdPs) and
// common friendly names (Okta, Google Workspace). `options.fieldsMap`
// overrides a field. UPN is deliberately not an email source: it need not be
// a deliverable or owned mailbox, and email drives account linking.
const DEFAULT_FIELDS: Record<string, string[]> = {
  email: [
    `${CLAIMS}/emailaddress`,
    "email",
    "mail",
    "emailAddress",
    "urn:oid:0.9.2342.19200300.100.1.3",
  ],
  given_name: [
    `${CLAIMS}/givenname`,
    "given_name",
    "givenName",
    "firstName",
    "urn:oid:2.5.4.42",
  ],
  family_name: [
    `${CLAIMS}/surname`,
    "family_name",
    "surname",
    "sn",
    "lastName",
    "urn:oid:2.5.4.4",
  ],
  name: [
    `${CLAIMS}/name`,
    "name",
    "displayName",
    "urn:oid:2.16.840.1.113730.3.1.241",
  ],
};

const EMAIL_NAME_ID_FORMAT =
  "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";

function firstValue(
  attributes: SamlAssertion["attributes"],
  names: string[],
): string | undefined {
  for (const name of names) {
    const value = attributes[name];
    const first = Array.isArray(value) ? value[0] : value;
    if (first) return first;
  }
  return undefined;
}

/** Maps a validated assertion to the normalized user info and raw profile. */
export function mapSamlAssertion(
  connection: Connection,
  assertion: SamlAssertion,
): UserInfoWithRaw {
  const { attributes } = assertion;
  const fieldsMap = connection.options?.fieldsMap || {};
  const namesFor = (field: string) => {
    const mapped = fieldsMap[field];
    if (mapped) return Array.isArray(mapped) ? mapped : [mapped];
    return DEFAULT_FIELDS[field] || [];
  };

  const userIdAttribute = connection.options?.user_id_attribute;
  const userId = userIdAttribute
    ? firstValue(attributes, [userIdAttribute])
    : assertion.nameId;
  if (!userId) {
    throw new Error(
      `SAML assertion has no value for the user id attribute ${userIdAttribute}`,
    );
  }

  const email =
    firstValue(attributes, namesFor("email")) ||
    (assertion.nameIdFormat === EMAIL_NAME_ID_FORMAT
      ? assertion.nameId
      : undefined);

  const userinfo: UserInfo = {
    // Auth0's samlp user id: samlp|{connection}|{user id}.
    sub: `${connection.name}|${userId}`,
    email,
    given_name: firstValue(attributes, namesFor("given_name")),
    family_name: firstValue(attributes, namesFor("family_name")),
    name: firstValue(attributes, namesFor("name")),
  };

  // Custom fieldsMap entries surface as profile fields of their own.
  const mappedExtras: Record<string, string> = {};
  for (const field of Object.keys(fieldsMap)) {
    if (field in DEFAULT_FIELDS) continue;
    const value = firstValue(attributes, namesFor(field));
    if (value !== undefined) mappedExtras[field] = value;
  }

  return {
    userinfo,
    raw: {
      ...attributes,
      ...mappedExtras,
      nameIdAttributes: {
        value: assertion.nameId,
        ...(assertion.nameIdFormat ? { Format: assertion.nameIdFormat } : {}),
      },
      ...(assertion.sessionIndex
        ? { sessionIndex: assertion.sessionIndex }
        : {}),
      ...(assertion.issuer ? { issuer: assertion.issuer } : {}),
    },
  };
}

/**
 * `code` is the posted SAMLResponse and `codeVerifier` the ID of the
 * AuthnRequest stored with the state.
 */
export async function validateAuthorizationCodeAndGetUserWithRaw(
  ctx: Ctx,
  connection: Connection,
  code: string,
  codeVerifier?: string,
): Promise<UserInfoWithRaw> {
  const verifier = ctx.env.samlVerifier;
  if (!verifier) {
    throw new Error(
      "SAML response verification is not configured: pass samlVerifier to init()",
    );
  }
  if (!codeVerifier) {
    throw new Error("Missing the AuthnRequest id for this SAML login");
  }

  const assertion = await validateSamlResponse({
    samlResponse: code,
    verifier,
    idpCertificates: getSamlIdpCertificates(connection),
    spEntityId: getSamlSpEntityId(requireTenantId(ctx), connection),
    assertionConsumerServiceUrl: getSamlAcsUrl(ctx, connection),
    inResponseTo: codeVerifier,
    idpEntityId: connection.options?.issuer,
  });

  return mapSamlAssertion(connection, assertion);
}

export async function validateAuthorizationCodeAndGetUser(
  ctx: Ctx,
  connection: Connection,
  code: string,
  codeVerifier?: string,
): Promise<UserInfo> {
  return (
    await validateAuthorizationCodeAndGetUserWithRaw(
      ctx,
      connection,
      code,
      codeVerifier,
    )
  ).userinfo;
}

// A SAMLResponse is a bearer credential: consume the state on first use so a
// captured response can't be replayed while the assertion is still valid.
export const singleUseState = true;
