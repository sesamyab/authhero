---
"authhero": patch
---

`/authorize` and `/passwordless/verify_redirect` now check the response type against the client's `grant_types`, as Auth0 does: a `code` response needs `authorization_code`, and a response returning `token` or `id_token` needs `implicit`. A client without `grant_types` is not restricted. The default application each tenant gets keeps `authorization_code` and `refresh_token`, so it supports the code flow only; add `implicit` to an application that needs token responses from `/authorize`. The connect flow's workspace picker is only offered on the multi-tenancy control plane.
