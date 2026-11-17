---
"@authhero/multi-tenancy": patch
---

Require `authhero` ^9.33.0 as a peer dependency. The tenant creator and owner roles rely on two things in authhero: an organization-scoped token is bound to the tenant its organization names (9.32.0), and the tenant operations routes check which tenant the caller may reach and know the `retry:tenant_provisioning` scope (9.33.0). With an older authhero a self-service creator's token is not bound to its tenant, and `read:tenant_operations` shows every tenant's operations. Upgrade `authhero` and `@authhero/multi-tenancy` together.
