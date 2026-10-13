---
"@authhero/adapter-interfaces": minor
"authhero": minor
---

Align pre-registration metadata setters with Auth0: `api.user.setUserMetadata()` now merges into `user_metadata` instead of writing to the root of the user, and the new `api.user.setAppMetadata()` merges into `app_metadata`. Hooks that relied on `setUserMetadata` setting root attributes (e.g. `given_name`) must set those through the user payload instead.
