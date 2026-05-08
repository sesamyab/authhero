---
"create-authhero": patch
---

Fix the scaffolder-generated `seed.ts` to pass `auth0_conformant` through from each client entry in the `--clients` JSON arg. The previous code copied a fixed set of fields (`client_id`, `client_secret`, `name`, `callbacks`, etc.) and silently dropped `auth0_conformant`, so clients defined as `{ ..., "auth0_conformant": false }` were created with Auth0-compatible defaults instead. This caused the OIDC conformance refresh-token test to fail with HTTP 403 (legacy Auth0 behavior) where the spec mandates HTTP 400 — the gate in `refresh-token.ts` reads `client.auth0_conformant`, but the value was never persisted.
