---
"authhero": minor
"@authhero/adapter-interfaces": minor
---

Honor the OIDC `claims` request parameter (OIDC Core 5.5). `/authorize` now parses the `claims` parameter (JSON-encoded individual claim requests for `id_token` and/or `userinfo`), persists the request on the login session, and emits the requested standard claims at both `/userinfo` and in the ID Token regardless of scope. Adds `claims_parameter_supported: true` to the discovery document. Closes the `oidcc-claims-essential` WARNING in the OIDC conformance Basic/Hybrid/Implicit/Form-Post/Dynamic plans (issue #781).
