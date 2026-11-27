---
"authhero": patch
---

Narrow the auth server's always-allowed redirect targets to the `/u/info` and `/u2/info` test screens. Any other path on the auth server now has to be registered in the client's callbacks to be used as a `redirect_uri` on `/authorize` or as `redirect_url` on `/account`. `/account` without `redirect_url` still returns to its own URL.
