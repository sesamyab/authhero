---
"create-authhero": patch
---

The `cloudflare-control-plane` template allows the CORS origins listed in `ALLOWED_ORIGINS` instead of the origin of each request, which allowed every site. The management API still allows an origin that is in the `web_origins` of a client of the tenant being called, so set the admin UI's origin in `ALLOWED_ORIGINS` or on its client.
