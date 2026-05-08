---
"authhero": minor
"@authhero/adapter-interfaces": minor
---

Add lazy-migration support from an upstream Auth0 tenant. Two flows are gated by the existing `connection.options.import_mode` flag (already part of the Auth0 connection schema):

- **Password fallback** — when a `Username-Password-Authentication` connection has `import_mode: true`, password logins that miss locally (no user, or no matching hash) fall back to the upstream Auth0's password-realm grant. On success the user/profile is fetched from `/userinfo` and the bcrypt hash is stored locally so subsequent logins are served entirely from authhero. No M2M token required.
- **Refresh-token proxy** — when a `strategy: "auth0"` connection has `import_mode: true`, refresh-token grant requests whose token doesn't match any local row are forwarded to the upstream `/oauth/token` and the response is relayed verbatim (rotation, error shapes, etc.). Existing Auth0 sessions keep working until the next interactive login migrates the user via the password-fallback path.

Configuration uses standard `connections` records — no new tenant fields, no new management API routes. A new `Strategy.AUTH0 = "auth0"` value identifies the upstream-source connection (filtered out of the universal-login button list automatically). The connection's `options` re-uses existing fields: `token_endpoint`, `userinfo_endpoint`, `client_id`, `client_secret`, `import_mode`. The react-admin connection edit form gains a dedicated section for these fields when `strategy === "auth0"`.
