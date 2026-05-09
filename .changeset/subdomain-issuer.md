---
"authhero": patch
---

When a request is resolved to a tenant via the host subdomain (e.g. `tenant.auth.example.com`), the tenant middleware now also sets `custom_domain` so issued tokens, the `/.well-known/openid-configuration` document, and other self-referencing URLs use the host the client actually called. If the request lands on the canonical `env.ISSUER` host the value is left unset to preserve byte-exact `iss` claims. The host-vs-ISSUER comparison is case-insensitive per RFC 3986 §3.2.2, while the original casing of the request's host header is preserved when `custom_domain` is set.
