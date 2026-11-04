---
"create-authhero": patch
---

The `cloudflare-control-plane` template passes the layer that returns secrets as stored (`rawAdapter`) to `initMultiTenant` as `storedDataAdapter`, and the in-process sync reads through it as well. A sync copies ciphertext, so the sync status, `verify` and rollouts have to hash the same layer: with the decrypting layer every tenant of a control plane that encrypts showed as `drifted`. Needs a `@authhero/multi-tenancy` release that has the option.
