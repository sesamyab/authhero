---
"authhero": patch
"@authhero/adapter-interfaces": patch
---

A login ticket from `/co/authenticate` is now bound to the connection that verified the credentials. `/co/authenticate` records the connection as `authParams.connection` on the ticket's login session, and redeeming a ticket at `/authorize` is rejected with `403 Invalid realm` when the `realm` is any other connection, including `realm=email`, or when the ticket's login session records no connection. Login tickets minted by `/co/authenticate` before this change are no longer redeemable; the user logs in again.
