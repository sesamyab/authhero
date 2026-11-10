---
"@authhero/multi-tenancy": patch
---

`initMultiTenant` accepts `databaseIsolation` and passes it to its provisioning hooks, so `onProvision` and `onDeprovision` run when a tenant is created or deleted. Before, the option was not part of its config and was never read.
