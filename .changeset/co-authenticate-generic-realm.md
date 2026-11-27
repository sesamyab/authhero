---
"authhero": patch
---

Fix embedded (cross-origin) password login for clients without an enabled database connection. `/co/authenticate` now records the generic `Username-Password-Authentication` realm on the login ticket when the client has no database connection, so `/authorize` no longer refuses the ticket with `403 Invalid realm`.
