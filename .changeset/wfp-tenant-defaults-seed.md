---
"@authhero/multi-tenancy": patch
---

`tenantDefaults` now also reach tenants with their own database (`deployment_type: "wfp"`). The provisioning seed that creates the tenant's own row in its database carries the tenant's settings (sessions, MFA, attack protection, flags, sender and so on) from its row on the control plane, through an allowlist. The control plane's own seeded row stays minimal, identity and deployment fields are not copied, the Twilio `auth_token` is stripped, and an existing row is never overwritten.
