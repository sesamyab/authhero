---
"create-authhero": patch
---

The `cloudflare-control-plane` template allows the CORS origins listed in `ALLOWED_ORIGINS` instead of the origin of each request, which allowed every site. Unset, it allows none, so set the admin UI's origin.
