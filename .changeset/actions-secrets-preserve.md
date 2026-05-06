---
"@authhero/adapter-interfaces": minor
"@authhero/kysely-adapter": patch
---

Action secrets PATCH now preserves existing values when an incoming secret omits its `value` (matched by `name`). The `value` field is optional on writes so admin UIs can round-trip a masked secrets list without overwriting stored values.
