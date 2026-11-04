---
"@authhero/multi-tenancy": minor
---

Add an optional `storedDataAdapter` to `initMultiTenant`: the same data adapter as `dataAdapter`, but the layer that returns secrets as stored (ciphertext). A sync copies secrets as stored, so the block it pushes to a tenant, and the hash of that block, are computed over ciphertext. The sync status (`expected_hash` and `drifted`), `GET /tenants/{id}/config-sync/verify`, the fleet rollouts and the in-process sync read through `dataAdapter`, and when that layer decrypts they hash plaintext instead. The two never agreed, so a control plane that encrypts at rest and pushes to tenants with their own database showed every tenant as drifted even though `verify` passed. Pass the layer the `syncDefaults` transport reads through as `storedDataAdapter`. It is used only to build and hash config blocks and for the in-process sync; requests are still served through `dataAdapter`. Without it the behaviour is unchanged.
