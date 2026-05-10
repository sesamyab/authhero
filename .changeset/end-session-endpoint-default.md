---
"authhero": patch
---

Advertise `end_session_endpoint` in `/.well-known/openid-configuration` by default. The `/oidc/logout` route (OIDC RP-Initiated Logout 1.0) is fully implemented and spec-compliant, but discovery used to gate it behind an opt-in flag — meaning RPs that discovered endpoints couldn't find logout at all.

The `oidc_logout.rp_logout_end_session_endpoint_discovery` tenant flag is now treated as opt-*out*: only `=== false` hides the endpoint from discovery. Existing tenants with the flag set to `true` are unaffected; existing tenants without the flag set will start advertising the endpoint (the route already worked — only its discoverability changes).

`/v2/logout` is unchanged. RPs that hit it directly continue to work.
