---
"@authhero/adapter-interfaces": minor
"@authhero/kysely-adapter": minor
"@authhero/drizzle": minor
"authhero": minor
---

Add checkpoint pagination (`from`/`take` with an opaque `next` cursor) to `GET /organizations/{id}/invitations`, `/enabled_connections` and `/members/{user_id}/roles`. Organization connections get an optional `listCheckpoint` adapter method and `invites.list` returns `next` in checkpoint mode with the organization filter applied in the query. A malformed `from` cursor on `GET /users/{id}/permissions` now returns 400 instead of 500. Part of #1543.
