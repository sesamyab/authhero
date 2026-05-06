---
"@authhero/adapter-interfaces": minor
"authhero": minor
"@authhero/kysely-adapter": minor
---

Add `/api/v2/log-streams` and `/api/v2/attack-protection` management endpoints,
and stop merging locale defaults into the GET response of
`/api/v2/prompts/{prompt}/custom-text/{language}`. The terraform `auth0/auth0`
provider can now drive log streams, attack-protection settings, and prompt
custom text against authhero without the apply hanging on PUT/GET drift.
