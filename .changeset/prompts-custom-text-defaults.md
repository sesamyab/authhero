---
"authhero": minor
"@authhero/react-admin": minor
---

Expose bundled prompt text defaults via `GET /api/v2/prompts/custom-text/defaults`. Optional `language` and `prompt` query parameters narrow the response. The endpoint returns the shipped locale strings as `{ prompt, language, custom_text }` entries so the admin UI can render placeholder values and discover which prompt/screen forms exist without inferring them from per-tenant overrides. This is an authhero extension; Auth0 has no equivalent endpoint.

The react-admin custom-text editor now consumes this endpoint: opening an entry pre-populates every shipped field for the prompt/language pair, shows the bundled default as the input placeholder and as `helperText`, and renders fields that the tenant hasn't overridden so admins can see the full surface area at a glance.
