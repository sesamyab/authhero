---
"authhero": minor
"@authhero/adapter-interfaces": minor
"@authhero/kysely-adapter": minor
---

Add tenant-level **Migration Sources** for transparently re-minting upstream refresh tokens (#833).

When a client presents a refresh token that doesn't match a local row, AuthHero now:

1. Lists the tenant's enabled migration sources.
2. For each, redeems the token at the upstream `/oauth/token` (`grant_type=refresh_token`) using the source's credentials.
3. On success, calls `/userinfo` to learn the upstream `sub`.
4. Resolves or lazily creates the local user via the standard `getOrCreateUserByProvider` path (running the existing user-registration hooks).
5. Mints native AuthHero `access_token` / `id_token` / `refresh_token` and returns them.
6. If every source rejects, falls back to the existing `invalid_grant`.

The client keeps using `grant_type=refresh_token` — no SDK change. After one exchange per user, that user is fully on the AuthHero side.

**New:**

- `MigrationSource` adapter entity at the tenant level: `provider` (`auth0` | `cognito` | `okta` | `oidc`), `connection`, `enabled`, `credentials` (`domain` / `client_id` / `client_secret` / optional `audience` / `scope`).
- `migrationSources?: MigrationSourcesAdapter` on `DataAdapters` (optional — adapters that don't implement it simply omit it; the re-mint flow becomes a no-op).
- `MigrationProvider` interface (`exchangeRefreshToken`, `fetchUserInfo`) with an Auth0 implementation. Cognito/Okta/generic OIDC will be added in follow-ups.
- `/api/v2/migration-sources` Management API (full CRUD); permissions `create|read|update|delete:migration_sources` are seeded automatically.
- `client_secret` is redacted (`"***"`) on every management-API response.
- Kysely migration `2026-05-14T10:00:00_migration_sources` adds the `migration_sources` table.

**Out of scope (follow-ups):** bulk user import via the same provider abstraction, Cognito / Okta / generic OIDC providers, account-link / `identities[]` migration, react-admin UI.
