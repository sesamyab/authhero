---
title: SAML Connections
description: Let users sign in through an upstream SAML 2.0 identity provider (Okta, Microsoft Entra ID, ADFS, Google Workspace) with an Auth0-compatible samlp connection.
---

# SAML Connections

A `samlp` connection lets users sign in with an external SAML 2.0 identity provider (IdP) such as Okta, Microsoft Entra ID, ADFS, Google Workspace or Shibboleth. AuthHero is the **service provider** (SP): it sends the user to the IdP with an `AuthnRequest` and accepts the signed `SAMLResponse` the IdP posts back.

This is the opposite direction of the [SAML IdP addon](./index.md), where AuthHero signs assertions for a downstream SAML application.

## Enable signature verification

AuthHero only trusts a SAML response whose signature it has checked against the IdP's certificate. Verification is pluggable, like signing; pass a verifier to `init()`:

```typescript
import { init } from "authhero";
import { LocalSamlVerifier } from "@authhero/saml/local-verifier";

const app = init({
  dataAdapter,
  samlVerifier: new LocalSamlVerifier(),
});
```

`LocalSamlVerifier` uses `xml-crypto`, which is loaded on the first SAML login. It runs on Node.js and on Cloudflare Workers with the `nodejs_compat` compatibility flag (all `create-authhero` Workers templates set it).

Without a verifier, every SAML response is rejected and the login fails with `connection_error`.

## Create a connection

The quickest way is to give AuthHero the IdP's metadata, either as a URL or as XML. On create or update, AuthHero reads the sign-in URL, sign-out URL, signing certificate(s) and the IdP's entity ID from it:

```http
POST /api/v2/connections
Content-Type: application/json

{
  "name": "acme-okta",
  "strategy": "samlp",
  "options": {
    "metadataUrl": "https://acme.okta.com/app/exk123/sso/saml/metadata",
    "domain_aliases": ["acme.com"]
  }
}
```

Or configure it by hand:

```json
{
  "name": "acme-adfs",
  "strategy": "samlp",
  "options": {
    "signInEndpoint": "https://adfs.acme.com/adfs/ls/",
    "signOutEndpoint": "https://adfs.acme.com/adfs/ls/?wa=wsignout1.0",
    "signingCert": "-----BEGIN CERTIFICATE-----\nMIIC...\n-----END CERTIFICATE-----",
    "issuer": "http://adfs.acme.com/adfs/services/trust"
  }
}
```

In the admin UI, create a connection with the **SAML** strategy and fill in its details tab.

### Options

| Option               | Description                                                                                                                                                                                                                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `metadataUrl`        | IdP metadata URL. Fetched on create/update when it changes or when the sign-in URL or certificate is missing. Must be a public `https` URL.                                                                                                                                                                                             |
| `metadataXml`        | IdP metadata XML, as an alternative to `metadataUrl`.                                                                                                                                                                                                                                                                                   |
| `signInEndpoint`     | The IdP's single sign-on URL.                                                                                                                                                                                                                                                                                                           |
| `signOutEndpoint`    | The IdP's single logout URL (stored; SP-initiated logout is not sent yet).                                                                                                                                                                                                                                                              |
| `signingCert`        | The IdP's signing certificate: PEM, base64 DER, or base64 of the PEM (Auth0's format).                                                                                                                                                                                                                                                  |
| `signingCerts`       | Further trusted certificates, e.g. the incoming one during an IdP certificate rotation. Filled from metadata that lists several.                                                                                                                                                                                                        |
| `issuer`             | The IdP entity ID. When set, the assertion's `Issuer` must match it. Filled from metadata.                                                                                                                                                                                                                                              |
| `protocolBinding`    | How the `AuthnRequest` is sent: `urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect` (default) or `…:HTTP-POST`.                                                                                                                                                                                                                        |
| `signSAMLRequest`    | Sign the `AuthnRequest` with the tenant's SAML key. HTTP-Redirect binding only: a signed POST configuration is rejected on save.                                                                                                                                                                                                        |
| `signatureAlgorithm` | `rsa-sha256` (default) or `rsa-sha1`, for signed requests.                                                                                                                                                                                                                                                                              |
| `user_id_attribute`  | SAML attribute holding the user id. Takes precedence over `fieldsMap.user_id`; without either, the user id is the `NameID`.                                                                                                                                                                                                             |
| `fieldsMap`          | Profile field → SAML attribute name(s), e.g. `{ "email": "mail", "department": "dept" }`. Overrides the defaults below; other keys become profile fields. As in Auth0, `user_id` picks the user id (the first listed attribute present; the `NameID` counts as `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier`). |
| `entityId`           | SP entity ID override. Defaults to `urn:auth0:{tenant_id}:{connection}`.                                                                                                                                                                                                                                                                |
| `callback_url`       | ACS URL override, used verbatim.                                                                                                                                                                                                                                                                                                        |
| `domain_aliases`     | Email domains routed to this connection by [Home Realm Discovery](/features/home-realm-discovery).                                                                                                                                                                                                                                      |

## Register AuthHero at the IdP

Give the IdP administrator these values, with `{auth-domain}` the domain users sign in on (the tenant's custom domain if it has one):

| Setting                                      | Value                                                          |
| -------------------------------------------- | -------------------------------------------------------------- |
| Assertion Consumer Service (ACS) / Reply URL | `https://{auth-domain}/login/callback?connection={connection}` |
| Entity ID / Audience                         | `urn:auth0:{tenant_id}:{connection}` (or `options.entityId`)   |
| SP metadata                                  | `https://{auth-domain}/samlp/metadata?connection={connection}` |

These are Auth0's URL shapes, so an IdP configured for an Auth0 connection keeps working once the domain and entity ID match. The SP metadata includes the tenant's SAML certificate when `signSAMLRequest` is on.

The IdP must:

- post the response to the ACS URL with the **HTTP-POST** binding;
- **sign** the response, the assertion, or both;
- **not encrypt** the assertion (encrypted assertions are rejected with a clear error).

## Login flow

1. The user picks the connection, or Home Realm Discovery routes their email domain to it.
2. AuthHero redirects (or, with the HTTP-POST binding, auto-posts) an `AuthnRequest` to `signInEndpoint`. Its `RelayState` identifies the login, and its `ID` is stored with it.
3. The IdP posts a `SAMLResponse` to the ACS URL.
4. AuthHero validates it and continues the login like any other connection: account linking, actions, MFA and the token response all apply.

The user id is Auth0's `samlp|{connection}|{user id}`. Users are found by that id only, never by email: when another SAML connection's IdP asserts an email that a user of a different SAML connection already has, the login fails with a conflict instead of signing in to that account.

### What is validated

- The response or assertion is signed by one of the configured certificates. The assertion is read **only** from the signed XML, never from the posted document, which rules out signature-wrapping attacks. Certificates embedded in the response are ignored, and HMAC signatures are not accepted.
- The response carries exactly one assertion, and it is the signed one.
- `InResponseTo` matches the `AuthnRequest` this login sent.
- The bearer `SubjectConfirmationData` `Recipient` is the ACS URL, and it has not expired.
- `Destination`, when present, is the ACS URL.
- The audience includes the SP entity ID.
- `NotBefore` / `NotOnOrAfter` and `SessionNotOnOrAfter` hold, with two minutes of clock skew.
- The `Issuer` matches `options.issuer`, when set.
- Each login's state is consumed on first use, so a captured response cannot be replayed.
- The assertion has an `AuthnStatement`, and no condition other than `AudienceRestriction`, `OneTimeUse` or `ProxyRestriction` (an unknown condition makes it invalid). `ProxyRestriction Count="0"` is refused: it forbids passing the login on, and every AuthHero login ends in tokens or a SAML response for an application.
- Documents with a `DOCTYPE` are rejected.

An IdP error status (the user cancelled, or has no access to the application) is shown to the user as `access_denied` with the IdP's status message.

### Attribute mapping

All SAML attributes are stored on the identity's profile under their full names, along with `nameIdAttributes`, `sessionIndex` and `issuer`. The user's root attributes are filled from:

| Field         | SAML attributes (first match)                                                                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email`       | `http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress`, `email`, `mail`, `emailAddress`, `urn:oid:0.9.2342.19200300.100.1.3`, else the `NameID` if its format is `emailAddress` |
| `given_name`  | `…/claims/givenname`, `given_name`, `givenName`, `firstName`, `urn:oid:2.5.4.42`                                                                                                              |
| `family_name` | `…/claims/surname`, `family_name`, `surname`, `sn`, `lastName`, `urn:oid:2.5.4.4`                                                                                                             |
| `name`        | `…/claims/name`, `name`, `displayName`, `urn:oid:2.16.840.1.113730.3.1.241`                                                                                                                   |

The UPN is deliberately not used as an email: it need not be a mailbox the user owns, and email drives account linking.

## Not supported yet

- IdP-initiated SSO (an unsolicited response without `RelayState`); the user must start the login from the application.
- Encrypted assertions and encrypted `NameID`s.
- Signed `AuthnRequest`s with the HTTP-POST binding.
- Sending a `LogoutRequest` to the IdP on logout.
