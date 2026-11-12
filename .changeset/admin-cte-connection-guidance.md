---
"@authhero/admin": patch
---

The token exchange profile form warns when the selected connection is used for login: an `email` or `sms` connection, whose users would share a namespace with exchanged users, or the `Username-Password-Authentication` database connection, whose password users share ids and emails with exchanged users (a subject equal to a password user's id resolves to that user). It recommends a dedicated database connection. The connection's helper text shows the resulting user id, `<strategy>|<sub>` with the selected connection's actual strategy. The "Password" strategy choice on the connection create page is now labelled "Database".
