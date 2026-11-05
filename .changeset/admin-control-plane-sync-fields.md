---
"@authhero/admin": patch
---

A tenant's config sync mode and parent are now read from and saved on the control plane's record of the tenant. The settings endpoint is the tenant's own, and for a tenant that runs in its own worker it is answered by that worker, which showed the worker's copy and refused a change with `403 Only the control plane can change a tenant's config_sync mode`. A changed mode or parent is sent to `PATCH /tenants/{id}`; if the control plane has no such route (older packages) the save goes to the tenant's settings as before, and a refusal is shown rather than hidden. When the control plane's record cannot be read, the form behaves as it did.
