---
"authhero": patch
---

Resolve the scopes requested for a Management API audience against the user's permissions in every case. A requested scope the resource server does not define is kept in the `scope` claim only when the user holds it as a permission, and user permissions apply even when that resource server has RBAC turned off. Other resource servers behave as before.
