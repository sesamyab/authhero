---
"@authhero/adapter-interfaces": minor
---

`AuthParams` has an optional `connection`: the database connection the `/authorize` `connection` parameter names, so universal login uses it for password login, signup and reset. It is stored in the login session's `authParams` JSON, so no migration is needed.
