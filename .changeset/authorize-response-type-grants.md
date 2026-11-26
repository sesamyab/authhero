---
"authhero": patch
---

`/authorize` and `/passwordless/verify_redirect` now check the response type against the client's `grant_types`, as Auth0 does: a `code` response needs `authorization_code`, and a response returning `token` or `id_token` needs `implicit`. A client without `grant_types` is not restricted. The connect flow's workspace picker is only offered on the multi-tenancy control plane.
