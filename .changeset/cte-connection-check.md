---
"authhero": patch
---

Custom Token Exchange only resolves a user that belongs to the connection the profile or the action's `setUserByConnection` names. Database connections share the `auth0` provider, so a subject whose `sub` matched the id of an existing password user used to get tokens for that user. The exchange now fails with `400 invalid_request` and an `fecte` log naming the user, its connection and the expected connection. When creating the user fails because another user already has the same email or username, the exchange returns `400 invalid_request` with an `fecte` log instead of a `409`.
