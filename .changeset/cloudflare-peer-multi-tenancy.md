---
"@authhero/cloudflare-adapter": patch
---

Require `@authhero/multi-tenancy` 15.6.0 or later. The `sync-defaults` push and `createWfpTenantApp` now use `buildControlPlaneSigningKeys` and `applyControlPlaneSigningKeys`, which earlier versions do not export. With the old peer range a package manager accepted a lockfile that kept an older `@authhero/multi-tenancy` next to this version, and the first sync failed with a missing export.
