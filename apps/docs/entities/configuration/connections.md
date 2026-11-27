---
title: Connections
description: Configure authentication methods in AuthHero including database connections, social logins (Google, Apple, Facebook, GitHub, Microsoft, Vipps), and enterprise OIDC/OAuth2 and SAML connections.
---

# Connections

Connections are authentication methods available to users, such as username/password, passwordless email/SMS codes, social logins, or enterprise identity providers that speak OpenID Connect, OAuth 2.0 or SAML 2.0.

## Connection Types

### Database Connections

Username and password authentication with AuthHero storing credentials:

```typescript
{
  "name": "Username-Password-Authentication",
  "strategy": "auth0",
  "enabled_clients": ["client_123"]
}
```

### Social Connections

Third-party identity providers. The built-in strategies are `google-oauth2`, `apple`, `facebook`, `github`, `windowslive` (Microsoft accounts) and `vipps`:

```typescript
{
  "name": "google-oauth2",
  "strategy": "google-oauth2",
  "options": {
    "client_id": "google_client_id",
    "client_secret": "google_client_secret",
    "allowed_audiences": ["https://accounts.google.com"]
  }
}
```

### Enterprise Connections

Enterprise identity providers that speak OpenID Connect, OAuth 2.0 or SAML 2.0. The built-in enterprise strategies are `oidc`, `oauth2`, `okta` (handled as OIDC, with Auth0's `okta|<sub>` user ids), `waad` (Microsoft Entra ID) and `samlp` (any SAML 2.0 identity provider, see [SAML](#saml) below). The `oidc` strategy does not use discovery, so the endpoints are configured explicitly:

```typescript
{
  "name": "corporate-oidc",
  "strategy": "oidc",
  "options": {
    "client_id": "upstream_client_id",
    "client_secret": "upstream_client_secret",
    "authorization_endpoint": "https://idp.corp.example.com/oauth2/authorize",
    "token_endpoint": "https://idp.corp.example.com/oauth2/token",
    "userinfo_endpoint": "https://idp.corp.example.com/oauth2/userinfo",
    "scope": "openid profile email"
  }
}
```

The upstream provider redirects back to `https://<your-auth-domain>/login/callback` unless the connection sets `options.callback_url`.

## SAML

SAML 2.0 works in both directions in AuthHero:

- **AuthHero as service provider** — a `samlp` connection lets users sign in with an upstream SAML identity provider (Okta, Microsoft Entra ID, ADFS, Google Workspace, Shibboleth). AuthHero sends an `AuthnRequest`, validates the signed response and creates the user as `samlp|{connection}|{user id}`.
- **AuthHero as identity provider** — a client with the `samlp` addon can start a SAML login at `/samlp/{client_id}`, and AuthHero answers with a signed SAML response. This is configured on the application, not as a connection — see the [SAML package](/customization/saml/) and [SAML 2.0](/standards/saml-2).

### SAML Connection Example

```typescript
{
  "name": "enterprise-saml",
  "strategy": "samlp",
  "options": {
    "signInEndpoint": "https://idp.corp.example.com/saml/sso",
    "signOutEndpoint": "https://idp.corp.example.com/saml/slo",
    "signingCert": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----",
    "issuer": "https://idp.corp.example.com/saml/metadata",
    "signSAMLRequest": true,
    "signatureAlgorithm": "rsa-sha256"
  }
}
```

Or set `options.metadataUrl` (or `metadataXml`) and AuthHero fills in the endpoints, certificate and issuer from the identity provider's metadata. SAML connections need a signature verifier passed to `init({ samlVerifier })`. [Set up SAML connections →](/customization/saml/connections)

LDAP and Active Directory connections are not supported.

## Passwordless Connections

Email or SMS-based authentication without passwords:

```typescript
{
  "name": "email",
  "strategy": "email",
  "options": {
    "from": "auth@example.com",
    "subject": "Your verification code"
  }
}
```

## Connection Configuration

Connections can be configured per application, allowing different apps to use different authentication methods. The body is the ordered list of connection ids:

```typescript
// Enable specific connections for an application
PATCH /api/v2/clients/{client_id}/connections
["con_database", "con_google", "con_corporate_oidc"]
```

You can also enable or disable one connection for several applications with `PATCH /api/v2/connections/{id}/clients`.

An application with no connections enabled uses every connection in the tenant.

### Several database connections on one application

An application can enable more than one database connection, as in Auth0. Password login, signup and password reset use one of them, chosen like this:

1. **The connection the request names**, when the application enables it: the `connection` parameter on `/authorize`, the `realm` of the password-realm grant on `/co/authenticate`, or the `connection` field of `/dbconnections/signup` and `/dbconnections/change_password`. A name the application doesn't enable is rejected (`/authorize` answers `403`, the others `400 invalid_request`); another connection is never used instead. The generic `Username-Password-Authentication` names a connection only when one has that exact name, and otherwise means "the default".
2. **Otherwise the application's first enabled database connection**, in the order of its connection list. The admin UI lists database connections in their own section, in that order, and marks the default.
3. **An application with no connections enabled** uses the tenant's oldest database connection, by creation time.

A login looks the user up in the chosen connection only, not across database connections. (User rows from before AuthHero recorded a database user's connection name stay visible to every connection.)

A database connection that only receives users from a [Custom Token Exchange](../../features/custom-token-exchange) profile doesn't need to be enabled on any application. To transfer its users into an application with [session transfer](../../features/session-transfer), enable it on that application next to its login connection; put the login connection first so it stays the default.

Not implemented yet, compared with Auth0:

- **Organization logins** use the application's connections. Auth0 replaces them with the organization's enabled connections.
- **`default_directory`** (the tenant setting Auth0 uses for the `password` grant without a realm) is stored but unused: AuthHero has no `password` grant on `/oauth/token`.
- **Resuming a login with `/authorize?state=`** fills in the parameters the request leaves out from the stored login session, but not `connection`. A request that resumes a session without sending `connection` again uses the application's default database connection.

## API Reference

- [GET /api/v2/connections](/api/endpoints#get-connections)
- [POST /api/v2/connections](/api/endpoints#create-connection)
- [PATCH /api/v2/connections/:id](/api/endpoints#update-connection)
- [DELETE /api/v2/connections/:id](/api/endpoints#delete-connection)
