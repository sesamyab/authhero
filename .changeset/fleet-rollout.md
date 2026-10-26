---
"@authhero/adapter-interfaces": minor
"@authhero/kysely-adapter": minor
"@authhero/drizzle": minor
"authhero": minor
"@authhero/multi-tenancy": minor
"@authhero/cloudflare-adapter": patch
---

Add staged fleet rollouts of synced config. A `config-sync` rollout syncs every synced tenant below a root as one `sync-defaults` operation per tenant, in waves (a canary, then cumulative percentages), ordered by depth so parents go before children, with a failure-rate health gate that pauses the rollout, resume, and per-wave progress. New management routes `POST/GET /rollouts`, `GET /rollouts/{id}`, `POST /rollouts/{id}/pause|resume` (scopes `read:rollouts`, `create:rollouts`, `update:rollouts`) and a `rollout_id` filter on a tenant's operations. Triggers: management-API writes to actions, hooks, hook code, connections and resource servers record a coalesced rollout request (new `actions`, `hooks` and `hookCode` entity hooks; the entity hook wrapper now passes extra create arguments through), `reconcileConfigDrift` compares each synced tenant's applied hash with its chain's current hash, writes `cfgdrift` logs and starts a rollout for what drifted, and `advanceRollouts` moves open rollouts along from a scheduled handler. `initMultiTenant` returns the `rollouts` deps and accepts a `rolloutExecutor`. The `rollouts` table gains `config` and `paused_reason` (kysely migration, drizzle control-plane `0002`).
