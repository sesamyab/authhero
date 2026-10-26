---
"authhero": minor
"@authhero/multi-tenancy": minor
---

Hide platform-scoped rows that a config sync delivered into a tenant from that tenant's management API. Actions (with versions and executions), hooks, hook code, connections, resource servers and, for tenants that receive config, the email provider with `scope: "platform"` and a synced id are missing from lists, answer 404 on get/update/delete, cannot be referenced by hooks or bindings, and are left out of tenant exports. The MCP endpoint, which calls these routes, follows. Control-plane credentials still see them, and code hooks that run inline in a management request read an unfiltered stack (`getExecutorData`), so platform hooks keep running. `protect-synced` now also enforces `override` and `enforce` on synced copies of connections, resource servers, actions and hooks, and refuses edits to code copied for a hook. New exports: `isSyncedRowId`, `withPlatformRowsHidden`, `getExecutorData`.
