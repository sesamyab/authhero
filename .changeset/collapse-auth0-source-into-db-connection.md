---
"authhero": major
"@authhero/adapter-interfaces": major
"@authhero/kysely-adapter": major
---

Collapse the `strategy: "auth0"` source connection into the destination DB connection. The migration credentials now live on the same connection users land on — matching Auth0's Custom Database shape — and are read from `options.configuration` (`token_endpoint`, `userinfo_endpoint`, `client_id`, `client_secret`).

**Breaking changes**

- The `strategy: "auth0"` connection type is removed (`Strategy.AUTH0` is no longer exported from `@authhero/adapter-interfaces`). The DB connection's `options.configuration` block now carries the upstream credentials; `options.import_mode: true` on that same connection enables password capture from the upstream.
- The refresh-token proxy to upstream Auth0 has been removed. Replacement via local re-mint is tracked in #833 — until that lands, upstream-issued refresh tokens are rejected and clients must re-authenticate.
- The `Auth0ProxyResponse` error class and `proxyRefreshToken` helper are deleted.

**Migration**

A kysely migration runs automatically: for each tenant with exactly one `strategy: "auth0"` connection and exactly one `Username-Password-Authentication` connection, the upstream credentials are merged into the DB connection's `options.configuration` and the source row is deleted. Tenants with multiple DB connections are skipped and logged — operators must merge manually.
