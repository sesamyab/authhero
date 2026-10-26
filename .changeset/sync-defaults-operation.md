---
"@authhero/adapter-interfaces": minor
"@authhero/multi-tenancy": minor
"authhero": minor
"@authhero/cloudflare-adapter": minor
"@authhero/admin": minor
---

Add the `sync-defaults` tenant operation. `POST /tenants/{id}/operations` with `{ "kind": "sync-defaults", "input": { "dry_run": true } }` syncs a tenant's resolved parent-chain config into its database as a tracked operation with step events and history, returns the diff of a dry run in the operation's `result`, and leaves a queryable `failed` row (returned with `201`) when a row or the transport fails. `initMultiTenant` wires an inline executor that syncs tenants sharing the control plane's database in-process; `syncDefaults` takes a transport for tenants with their own database. On Cloudflare, `runSyncDefaultsOperation` runs it as a Workflows instance (the executor now accepts `sync-defaults`), `createDispatchSyncConfig` pushes the resolved block to the new tenant route `/internal/sync-config` (true dry run, key-ring check, no seeds or signing keys), and the reconciler resolves a completed sync correctly. Operation `input` can now be set at creation, the recorder can store a `result`, and an executor binding can list the `kinds` it runs (others answer `501`). The admin UI gets "Preview sync" and "Sync config" actions with the diff shown per operation.
