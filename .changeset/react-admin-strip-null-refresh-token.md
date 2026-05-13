---
"@authhero/react-admin": patch
---

Strip null values from `refresh_token` in the client edit form before PATCHing. The numeric fields (`leeway`, `token_lifetime`, `idle_token_lifetime`) are optional on the server and reject null — untouched fields that were null in the stored record were round-tripping back as null on submit and failing validation.
