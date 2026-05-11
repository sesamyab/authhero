---
"authhero": patch
---

Screen-based universal login (`/u2/login/identifier`): apply Home Realm Discovery so an email whose domain matches a connection's `options.domain_aliases` is routed to that connection's IdP, matching the legacy `/u/` flow. Also replaced the "Email is not valid." message shown when no connection accepts the entered email with "User account does not exist" — the email itself is valid; the prior message was misleading.
