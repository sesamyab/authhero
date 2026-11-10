---
"create-authhero": patch
---

The `cloudflare-control-plane` template allows the CORS origins listed in `ALLOWED_ORIGINS` instead of the origin of each request, which allowed every site. The management API also checks clients' `web_origins`, but of different tenants on the preflight and on the call, so list the admin UI's origin in `ALLOWED_ORIGINS`.
