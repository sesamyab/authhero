---
"@authhero/admin": patch
---

The token exchange profile form warns when the selected connection is an `email` or `sms` connection, since exchanged users would share a namespace with the users who log in with it, and recommends a dedicated database connection. The connection's helper text shows the resulting user id (`auth0|<sub>` for a database connection). The "Password" strategy choice on the connection create page is now labelled "Database".
