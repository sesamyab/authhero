---
"@authhero/aws-adapter": minor
"authhero": patch
---

DynamoDB: add `listCheckpoint` for user permissions, user roles and organization connections, and pass `next` through for invitations, so the checkpoint (`from`/`take`) endpoints work on this adapter. The sessions, invitations and connected-clients checkpoint routes now also filter results by the requested user or organization, so adapters that ignore `q` cannot return other users' or organizations' rows. Part of #1543.
