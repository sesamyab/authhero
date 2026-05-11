---
"authhero": minor
"@authhero/adapter-interfaces": patch
---

Add OIDC Hybrid Flow support. `response_type` now accepts `code id_token`, `code token`, and `code id_token token` — the `/authorize` redirect returns a code in the same response as an `id_token` and/or `access_token` carried in the fragment (or via `response_mode=form_post`). The front-channel id_token includes `c_hash` (always) and `at_hash` (when an access_token is co-issued) per OIDC Core 3.3.2.11. Discovery's `response_types_supported` advertises the three new values, closing the Auth0 parity gap on hybrid response types. The new `oidcc-hybrid-certification-test-plan` is wired into the conformance runner.
