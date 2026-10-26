---
"authhero": minor
---

Management API errors now match Auth0's bodies, as a documented superset (#1585).

- Not-found and conflict responses use Auth0's `message` and `errorCode`
  (e.g. `404 {"message":"The user does not exist.","errorCode":"inexistent_user"}`),
  captured from a live Auth0 tenant. Where Auth0 sends no `errorCode`, one is
  added (`inexistent_role`, `inexistent_organization`, …). Every addition is
  listed under "AuthHero extensions" in the error-codes docs.
- Validation failures say which part of the request failed:
  `invalid_body`, `invalid_query_string` or `invalid_uri`, in Auth0's message
  format. A malformed JSON body returns `invalid_json`.
- Deleting a user, client, connection, resource server or client grant that
  doesn't exist returns `204`, as in Auth0.
- A control-plane token whose `tenant-id` names a tenant that doesn't exist
  gets `404 inexistent_tenant` instead of a misleading resource 404.
- The auth middleware returns Auth0's bodies: `401 Missing authentication`,
  `403 insufficient_scope`, and `401 invalid_token` for an invalid token
  (previously `403`).

**Breaking for string matchers:** error `message` texts changed (for example
`"User not found"` is now `"The user does not exist."`). Match on `errorCode`
instead.
