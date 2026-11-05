---
"@authhero/multi-tenancy": minor
"@authhero/cloudflare-adapter": minor
---

The `sync-defaults` operation now carries the control plane's public signing keys to a WFP tenant, next to the resolved config block. A tenant that never got the provisioning seed (one onboarded by hand), or has not seen a key rotation, can verify control-plane tokens after the next sync, and a rotated key no longer needs a re-seed. The keys are outside the block and its hash, so drift status is unchanged; the receiver adds missing keys by `kid` and a dry run writes nothing. A push without keys, from an older control plane, still works. `@authhero/multi-tenancy` exports `buildControlPlaneSigningKeys` and `applyControlPlaneSigningKeys` for hosts that wire their own transport.
