---
"@authhero/adapter-interfaces": minor
"@authhero/kysely-adapter": minor
"@authhero/drizzle": minor
"authhero": minor
---

Add checkpoint pagination (`from`/`take` with an opaque `next` cursor) to `GET /users/{id}/connected-clients` and `GET /failed-events`. `outbox.listFailed` returns `next` in checkpoint mode (most recently dead-lettered first, event id tiebreaker). Part of #1543.
