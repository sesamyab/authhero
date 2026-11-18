---
title: Connections
description: Configure authentication methods in AuthHero including database connections, social logins (Google, Facebook, GitHub), and enterprise SAML/LDAP connections.
---

# Connections

Connections are authentication methods available to users, such as username/password, social logins, or enterprise connections like SAML or LDAP.

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

Third-party identity providers like Google, Facebook, GitHub:

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

Enterprise identity providers using SAML, LDAP, or other protocols:

```typescript
{
  "name": "corporate-saml",
  "strategy": "samlp",
  "options": {
    "sign_in_endpoint": "https://idp.example.com/saml/sso",
    "sign_out_endpoint": "https://idp.example.com/saml/slo"
  }
}
```

## SAML Connections

SAML (Security Assertion Markup Language) is an enterprise authentication standard that enables single sign-on (SSO) between an identity provider (IdP) and service providers (SP). AuthHero acts as an identity provider and supports:

- **SAML Request Parsing**: Parse authentication requests from service providers
- **SAML Response Generation**: Create signed SAML responses with user attributes
- **SAML Metadata**: Provide metadata for service provider configuration
- **Flexible Signing**: Support for both local signing (Node.js) and HTTP-based signing (edge environments)

SAML connections are particularly useful for enterprise customers who need to integrate with existing identity management systems or provide SSO to third-party applications.

### SAML Configuration Example

```typescript
{
  "name": "enterprise-saml",
  "strategy": "samlp",
  "options": {
    "sign_in_endpoint": "https://idp.corp.example.com/saml/sso",
    "sign_out_endpoint": "https://idp.corp.example.com/saml/slo",
    "signing_cert": "-----BEGIN CERTIFICATE-----\\n...\\n-----END CERTIFICATE-----",
    "sign_saml_request": true,
    "signature_algorithm": "rsa-sha256",
    "digest_algorithm": "sha256"
  }
}
```

[Learn more about SAML →](/customization/saml/)

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
["con_database", "con_google", "con_corporate_saml"]
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

## API Reference

- [GET /api/v2/connections](/api/endpoints#get-connections)
- [POST /api/v2/connections](/api/endpoints#create-connection)
- [PATCH /api/v2/connections/:id](/api/endpoints#update-connection)
- [DELETE /api/v2/connections/:id](/api/endpoints#delete-connection)
