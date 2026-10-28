---
"@authhero/adapter-interfaces": minor
"@authhero/drizzle": minor
"@authhero/kysely-adapter": minor
"@authhero/aws-adapter": minor
---

Add the `tenantMemberRequests` adapter: team-change requests that a shard registers in its own database and the control plane writes the outcome back to (issue #1550). Adds the `tenant_member_requests` table to the drizzle core migrations (`0016`) and a kysely migration, a DynamoDB implementation, and the `tenant-members-request` tenant operation kind. The shard database migration has to be applied before code that writes requests is deployed.
