---
"@authhero/saml": minor
"@authhero/adapter-interfaces": minor
"authhero": minor
"@authhero/admin": minor
---

Add SAML connections (`samlp` strategy): AuthHero can now be the SAML service provider and sign users in through an upstream SAML 2.0 identity provider such as Okta, Microsoft Entra ID or ADFS, with Auth0-compatible options and endpoints.

- `@authhero/saml`: AuthnRequest builder, HTTP-Redirect encoding with query-string signing (WebCrypto), IdP metadata parser, SP metadata builder and `validateSamlResponse`, which reads the assertion only from signed content and checks signature, InResponseTo, recipient, audience, issuer and validity window. Signatures are checked through the new `SamlSignatureVerifier` interface; `LocalSamlVerifier` (new `@authhero/saml/local-verifier` entry) implements it with xml-crypto and runs on Node.js and on Cloudflare Workers with `nodejs_compat`.
- `@authhero/adapter-interfaces`: Auth0's `samlp` connection options (`signInEndpoint`, `signOutEndpoint`, `signingCert`, `metadataUrl`, `metadataXml`, `signSAMLRequest`, `protocolBinding`, `user_id_attribute`, `fieldsMap`, `entityId`, …). The user id is taken from `user_id_attribute`, else `fieldsMap.user_id` (as in Auth0), else the NameID; when migrating from Auth0, keep the same setting so users keep their ids.
- `authhero`: the `samlp` strategy, the ACS on `POST /login/callback?connection=…`, SP metadata on `GET /samlp/metadata?connection=…`, single-use login state against replay, `init({ samlVerifier })`, metadata resolution on connection create/update, and Home Realm Discovery for SAML connections.
- `@authhero/admin`: SAML fields on the connection details tab, with the ACS URL and entity ID to give the identity provider.
