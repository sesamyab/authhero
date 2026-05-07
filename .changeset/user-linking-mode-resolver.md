---
"authhero": minor
---

`init({ userLinkingMode })` now also accepts a resolver function `({ tenant_id, client_id }) => "builtin" | "off"` (sync or async), so the built-in email-based account-linking path can be turned off for specific tenants without needing a per-client override on every client.
