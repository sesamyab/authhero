---
"@authhero/kysely-adapter": minor
"@authhero/drizzle": minor
"authhero": minor
---

Add checkpoint pagination (`from`/`take` with an opaque `next` cursor) to `GET /hooks`, `/actions/actions`, `/forms`, `/flows` and `/grants`. The hooks, actions, forms, flows and grants adapters return `next` in checkpoint mode (newest first, id tiebreaker); `page`/`per_page` behaviour is unchanged. Part of #1543.
