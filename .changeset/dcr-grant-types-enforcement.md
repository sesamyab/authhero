---
"authhero": minor
---

Enforce `client.grant_types` at `POST /oauth/token`. When a client has a non-empty `grant_types` list, requests using a grant type not in that list are rejected with `400 unauthorized_client` (RFC 6749 §5.2). Clients with an empty or undefined `grant_types` continue to work as before, so this is a back-compat opt-in: set the field on a client to start enforcing.
