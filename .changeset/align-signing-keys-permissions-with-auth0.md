---
"authhero": patch
---

Align the `/api/v2/keys/signing*` management endpoints with Auth0's permission names. `GET /signing` and `GET /signing/{kid}` now require `read:signing_keys` (was `read:keys`), `POST /signing/rotate` requires `create:signing_keys` (was `create:keys`), and `PUT /signing/{kid}/revoke` requires `update:signing_keys` (was `update:keys`). The `auth:read` / `auth:write` super-scopes still grant access. Tokens minted against the old AuthHero-only names will need their permissions reissued; Auth0-style tokens that already carry `*:signing_keys` will now work where they previously returned 403.
