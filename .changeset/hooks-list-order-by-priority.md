---
"@authhero/kysely-adapter": patch
"@authhero/drizzle": patch
---

Hook dispatch now honors `priority` order. `hooks.list` returns rows ordered by `priority` desc with `created_at_ts` asc as tiebreaker, so the order configured in the Actions Triggers UI (and any other priority you set) determines the runtime execution order. Previously hooks ran in arbitrary DB order. Callers that pass an explicit `sort` keep that behavior.
