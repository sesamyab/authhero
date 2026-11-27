---
title: Auth0 Compatibility
description: AuthHero is compatible with Auth0 APIs and SDKs, with a few key differences.
---

# Auth0 Compatibility

AuthHero implements the Auth0 Management API v2 and Authentication API, which means you can use existing Auth0 SDKs and tools with minimal changes.

## What Works the Same

- **Auth0 SDKs** — `auth0-spa-js`, `auth0-react`, `nextjs-auth0`, and other client libraries work by pointing them at your AuthHero instance
- **Management API** — The `/api/v2/*` endpoints follow Auth0's API contract for users, clients, connections, roles, organizations, and more
- **OAuth2/OIDC** — Standard authorization code flow, PKCE, client credentials, refresh tokens, and device authorization
- **Token format** — JWT access tokens and ID tokens with the same claim structure
- **RBAC** — Resource servers, scopes, roles, and permissions work the same way
- **Organizations** — Organization membership, roles, and invitations follow the same model
- **Actions** — Stored Actions, versions, deploys, trigger bindings and execution records use the same API and the same `exports.onExecute…(event, api)` code format

## Key Differences

### Self-Hosted

AuthHero runs in your infrastructure. You control the database, the deployment, and the data. There is no hosted dashboard — use the [Admin UI](/apps/admin/) or the Management API directly.

### Actions and Hooks

AuthHero implements **Auth0 Actions**: JavaScript stored per tenant, bound to
triggers and run in a sandboxed code executor. The `/api/v2/actions/*` endpoints
(Actions, versions, deploy, trigger bindings, executions) follow Auth0's
contract. The main differences:

- **You choose the executor.** Actions only run when a code executor is
  configured, for example `WorkerLoaderCodeExecutor` on Cloudflare.
- **npm dependencies aren't loaded**, and the timeout is 5 seconds instead of 20.
- **Not every Auth0 trigger or API exists.** `post-login` Actions support claims,
  denials, account linking and MFA, but not `api.redirect` or `api.prompt`, and
  they don't run again on refresh. `post-change-password`, `send-phone-message`
  and `password-reset-post-challenge` are not available.
- **More triggers.** `validate-registration-username`, `pre-user-update`,
  `post-user-update`, `pre-user-deletion`, `post-user-deletion` and `pre-screen`,
  which runs before universal-login screens are shown and when they are
  submitted (Auth0 has no pre-login trigger).

Next to Actions, AuthHero keeps **hooks**: callbacks passed to `init()` that run
with full server access, URL webhooks, form and page hooks, and built-in
template hooks.

See [Actions](/features/actions) for the full reference and
[Auth0 Comparison — Actions & Hooks](/auth0-comparison/hooks) for a mapping.

### Account Linking

AuthHero supports account linking but with some differences in how linked accounts are updated. Updates to linked (secondary) accounts must go through the primary account.

See [Auth0 Comparison — Account Linking](/auth0-comparison/account-linking) for details.

### Multi-Tenancy

Auth0 uses one tenant per Auth0 account. AuthHero supports multiple tenants in a single instance, with optional organization-based isolation using the `@authhero/multi-tenancy` package.

See [Auth0 Comparison — Multi-Tenant](/auth0-comparison/multi-tenant) for details.

### Redirect URLs

AuthHero handles redirect URL validation with some differences in wildcard and localhost handling.

See [Auth0 Comparison — Redirect URLs](/auth0-comparison/redirect-urls) for details.

## Migrating from Auth0

To migrate from Auth0 to AuthHero:

1. Set up an AuthHero instance
2. Migrate users, clients, and connections via the Management API (or lazily — see [Lazy Migration](/auth0-comparison/lazy-migration))
3. Update your application's Auth0 configuration to point to AuthHero
4. Auth0 SDKs continue to work — just change the domain

See the [Auth0 Comparison](/auth0-comparison/) section for detailed migration guides.
