---
"@authhero/react-admin": patch
---

Fix client edit form sending `null` for cleared `refresh_token.leeway`, `refresh_token.token_lifetime`, and `refresh_token.idle_token_lifetime` fields. The API schema marks these as optional numbers (undefined OK, null rejected), so saving a client with any of them empty failed with `Expected number, received null`. The `NumberInput`s now parse empty/cleared values to `undefined` so the keys are omitted from the payload.
