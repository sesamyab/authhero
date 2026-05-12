---
"authhero": minor
"@authhero/adapter-interfaces": minor
"@authhero/kysely-adapter": minor
"@authhero/drizzle": minor
---

Promote `disable_sign_ups` from `client_metadata` to a typed top-level `boolean` field on `Client`, and add a new `hide_sign_up_disabled_error` flag for enumeration-safe sign-up blocking.

When `disable_sign_ups` is true and `hide_sign_up_disabled_error` is also true, the identifier screen no longer reveals that an email is unknown: it advances to the OTP/password challenge as if the account existed and fails generically at credential check. Skips OTP/magic-link delivery to unknown addresses in this stub path. Useful for tenants where email enumeration is a stronger concern than the UX cost of stranded users.

Adds a migration that copies `client_metadata.disable_sign_ups = "true"` into the new column and removes the key from `client_metadata` so there is a single source of truth going forward. The legacy `client_metadata.disable_sign_ups` key is no longer read by the engine.
