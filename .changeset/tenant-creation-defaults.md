---
"@authhero/multi-tenancy": minor
---

Copy-once defaults for new tenants (#1753). A new `tenantDefaults` option on `setupMultiTenancy` and `initMultiTenant` sets the tenant row's own settings (MFA, attack protection, flags, sessions and so on) when a tenant is created. They are the tenant's own afterwards: a change to the defaults does not reach existing tenants, the tenant can change every value, and a value in the create request wins. It can be a function, so a plan can decide the values later. Unset changes nothing.
