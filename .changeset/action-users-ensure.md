---
"authhero": minor
"@authhero/adapter-interfaces": minor
---

Actions can anchor users to a record in an external system (issue #1802). `api.users.ensure({ connection, id, profile, app_metadata })` creates or updates `<connection>|<id>` in a connection with the new non-login `external` strategy and `options.allow_action_users: true`, and `api.user.setLinkedTo` can then link the signing-in user under it. Available in `pre-user-registration` and `post-user-login`. External primaries always stay primary, a user already under one is never moved to another by a login, and `external` connections never appear on login screens or work with `/authorize?connection=`. A `pre-user-registration` `setLinkedTo` to a user that doesn't exist now registers the user unlinked and logs `primary_not_found`, instead of failing the registration.
