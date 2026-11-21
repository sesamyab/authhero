---
"@authhero/admin": patch
---

The client Connections tab lists database connections in their own section, in order, marks the first as the default for password login, and lets you reorder them. Failed admin API requests now report the response's JSON `message` (or the status text) instead of the raw body, and the Connections tab shows it when a save fails.
