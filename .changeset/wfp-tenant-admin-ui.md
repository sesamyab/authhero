---
"create-authhero": minor
---

The `cloudflare-wfp-tenant` template can now serve the admin UI at `/admin` (`--admin-ui`, asked for interactively and on by default with `--yes`). The admin signs in against the tenant Worker's own issuer, so a tenant manages itself without going through the control plane.
