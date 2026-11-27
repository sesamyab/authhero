---
"@authhero/saml": minor
"authhero": minor
"@authhero/admin": minor
---

Close gaps in AuthHero as SAML identity provider:

- `POST /samlp/{client_id}` accepts AuthnRequests over the HTTP-POST binding, which the IdP metadata already advertised.
- AuthnRequests are read whatever namespace prefix the service provider uses (`samlp:`, `saml2p:`, default namespace), via the new `parseSamlAuthnRequest`.
- Signed requests: with the SP's certificate in `addons.samlp.signingCert` (Auth0's setting), AuthnRequests and LogoutRequests must be signed with it. HTTP-Redirect query-string signatures are checked with WebCrypto (`verifyRedirectBindingSignature`), HTTP-POST XML signatures with the configured `samlVerifier`. `require_signed_requests` without a certificate still refuses every request.
- The IdP metadata's `entityID` is now the issuer the assertions carry, instead of the SP's audience.
- Admin: the client's SSO tab takes the SP's request signing certificate.
