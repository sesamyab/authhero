---
"authhero": patch
"@authhero/adapter-interfaces": patch
---

A login ticket from `/co/authenticate` is now bound to the connection that verified the credentials. `/co/authenticate` records the connection as `authParams.connection` on the ticket's login session, and redeeming the ticket at `/authorize` with any other `realm`, including `realm=email`, is rejected with `403 Invalid realm`.
