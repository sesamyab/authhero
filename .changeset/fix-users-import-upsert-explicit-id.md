---
"authhero": patch
---

Fix users-import jobs treating an existing user matched by an explicit `user_id` as the row's own earlier write. With `upsert: true` the user is now updated and the row reports `updated`; with `upsert: false` the row fails with `USER_ALREADY_EXISTS`, as in Auth0, instead of reporting `inserted` without writing anything.
