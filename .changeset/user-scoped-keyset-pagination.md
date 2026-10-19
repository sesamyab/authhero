---
"@authhero/adapter-interfaces": minor
"@authhero/kysely-adapter": minor
"@authhero/drizzle": minor
"@authhero/aws-adapter": patch
"authhero": minor
---

Add checkpoint pagination (`from`/`take` with an opaque `next` cursor) to `GET /users/{id}/sessions`, `/logs`, `/organizations`, `/permissions` and `/roles`. User permissions and roles get optional `listCheckpoint` adapter methods, `sessions.list` and `userOrganizations.listUserOrganizations` return `next` in checkpoint mode, and the kysely user-permissions list now joins resource servers on `identifier`. Part of #1098.
