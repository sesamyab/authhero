---
title: SAML 2.0
description: AuthHero's implementation status for SAML 2.0, as identity provider and as service provider.
---

# SAML 2.0

**Spec:** [OASIS SAML 2.0](https://wiki.oasis-open.org/security/FrontPage)
**Status:** Partial

SAML 2.0 support is provided by [`@authhero/saml`](/customization/saml/) and works in both directions: AuthHero as the identity provider for downstream SAML applications, and AuthHero as the service provider federating to an upstream SAML identity provider.

## AuthHero as identity provider

### Implemented

- **SSO endpoint** — `/samlp/{client_id}` accepts an `AuthnRequest` and issues a signed SAML response.
- **Metadata** — `/samlp/metadata/{client_id}` publishes IdP metadata XML.
- **HTTP-POST binding** — SAML responses are delivered via an auto-submitting HTML form POST to the SP's `AssertionConsumerServiceURL`, which must be one of the application's callback URLs.
- **Signed assertions** — assertions are signed with the tenant's X.509 signing key. Certificates are tenant-scoped and can be rotated with a staging window, renewed over the same key pair, or revoked — see [Certificate lifecycle](/customization/saml/configuration#certificate-lifecycle).
- **Attribute statements** — standard user attributes are mapped into SAML attributes.
- **Single Logout** — `/samlp/{client_id}/logout` accepts a `LogoutRequest` (HTTP-Redirect and HTTP-POST) and answers with a `LogoutResponse`.
- **Custom signers** — tenants can supply their own signing implementation via the [SAML package](/customization/saml/custom-signers).

### Partial / not yet implemented

- **Signed AuthnRequests** — request signatures are not verified; a client with `require_signed_requests` refuses all requests.
- **HTTP-POST binding for AuthnRequests** — only HTTP-Redirect is accepted on the SSO endpoint.
- **IdP-initiated SSO** — a response is only issued for an `AuthnRequest`.
- **Assertion encryption** — assertions are signed but not encrypted.

## AuthHero as service provider (SAML connections)

See [SAML Connections](/customization/saml/connections).

### Implemented

- **`samlp` connections** with Auth0's option names, entity ID (`urn:auth0:{tenant}:{connection}`) and endpoints.
- **AuthnRequest** over the HTTP-Redirect binding (optionally signed with the tenant's SAML key) or the HTTP-POST binding.
- **ACS** — `POST /login/callback?connection={connection}` accepts responses over the HTTP-POST binding.
- **Response validation** — signature against the configured IdP certificate(s), with the assertion read only from signed content; one assertion per response; `InResponseTo`, `Recipient`, `Destination`, audience, issuer and validity window checks; replay protection through single-use login state.
- **SP metadata** — `GET /samlp/metadata?connection={connection}`.
- **IdP metadata import** — `metadataUrl` or `metadataXml` fill the sign-in URL, sign-out URL, certificates and IdP entity ID on create/update.
- **Attribute mapping** — WS-Fed claim URIs, LDAP OIDs and common friendly names, overridable with `fieldsMap`; `user_id_attribute` for the user id.
- **Home Realm Discovery** via `domain_aliases`.

### Partial / not yet implemented

- **IdP-initiated SSO** — unsolicited responses are rejected.
- **Encrypted assertions** and encrypted `NameID`s — rejected with a clear error.
- **Signed AuthnRequests over HTTP-POST** — signing needs the HTTP-Redirect binding.
- **SP-initiated Single Logout** — `signOutEndpoint` is stored but no `LogoutRequest` is sent.

## Related AuthHero documentation

- [SAML Package](/customization/saml/)
- [SAML Connections](/customization/saml/connections)
- [SAML Configuration](/customization/saml/configuration)
- [SAML Migration from Auth0](/auth0-comparison/saml-migration)
