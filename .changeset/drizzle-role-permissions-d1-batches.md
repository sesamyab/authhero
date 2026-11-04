---
"@authhero/drizzle": patch
---

Write role permissions in batches so assigning or removing hundreds of permissions works on D1, which rejects statements that bind more than 100 parameters. Seeding a tenant's admin role (252 management scopes) failed on D1 before this.
