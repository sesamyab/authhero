---
title: Error Codes
description: Reference guide for AuthHero API error codes including HTTP status codes, authentication errors, and user-related error responses.
---

# Error Codes

This document provides a reference for error codes returned by the AuthHero API.

## Error Response Format

AuthHero uses two different error shapes, depending on which API you are calling.

### Management API

Management API errors (`/api/v2/*`) use Auth0's shape, so Auth0 SDKs, including
`go-auth0` and the Terraform provider, which parse error bodies strictly, can
unmarshal them and branch on `errorCode`:

```json
{
  "statusCode": 404,
  "error": "Not Found",
  "message": "The user does not exist.",
  "errorCode": "inexistent_user"
}
```

The bodies are a **superset** of Auth0's. For the responses listed in
[Management API error codes](#management-api-error-codes), AuthHero returns
Auth0's exact `message` and `errorCode`. Validation messages follow Auth0's
wording but leave out the property descriptions Auth0 appends. Wherever Auth0
omits `errorCode`, AuthHero adds one. Every difference is listed under
[AuthHero extensions](#authhero-extensions).

### OAuth and OIDC endpoints

The OAuth 2.0 / OIDC endpoints (`/authorize`, `/oauth/token`, `/userinfo`,
`/oidc/register`, …) return the error codes defined by their respective RFCs:

```json
{
  "error": "invalid_grant",
  "error_description": "Invalid authorization code"
}
```

For redirect-based failures at `/authorize`, the same `error` and
`error_description` are delivered as query parameters on the client's
`redirect_uri` (or in the fragment for non-`code` response types, or via
`postMessage` for `web_message` requests) rather than as a JSON body.

A handful of interactive login errors carry an uppercase `code` alongside the
message instead — see [Login flow error codes](#login-flow-error-codes) below.

## Common HTTP Status Codes

- `400 Bad Request`: The request was invalid or cannot be served
- `401 Unauthorized`: Authentication is required or failed
- `403 Forbidden`: The authenticated user doesn't have permission
- `404 Not Found`: The requested resource doesn't exist
- `429 Too Many Requests`: Rate limit exceeded
- `500 Internal Server Error`: An error occurred on the server

## OAuth 2.0 / OIDC error codes

These are the `error` values returned by the OAuth and OIDC endpoints.

| Code                     | Typical status | Meaning                                                                                                          |
| ------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------- |
| `invalid_request`        | 400            | The request is missing a required parameter, or a parameter is malformed                                         |
| `invalid_client`         | 401 / 403      | Client authentication failed — unknown `client_id`, wrong `client_secret`, or an unacceptable `client_assertion` |
| `invalid_grant`          | 403            | The authorization code or refresh token is invalid, expired, already used, or was issued to another client       |
| `unauthorized_client`    | 403            | The client is not allowed to use this grant type                                                                 |
| `unsupported_grant_type` | 400            | The requested `grant_type` is not supported                                                                      |
| `invalid_scope`          | 400            | A requested scope is unknown or not permitted for this client                                                    |
| `access_denied`          | 403            | The request was refused — for example the user denied consent, or the account is blocked                         |
| `server_error`           | 500            | An unexpected error occurred while handling the request                                                          |

`invalid_grant` is returned with `403` to match Auth0. Clients registered with
`auth0_conformant: false` get RFC 6749 §5.2's `400` for the same failure
instead.

Two credential-exchange failures deliberately do **not** use `invalid_grant`:

- A bad **passwordless OTP** (the
  `http://auth0.com/oauth/grant-type/passwordless/otp` grant) returns `400`
  with a human-readable, localized `message` — "Invalid code", "Code expired"
  or "Code is already used" — and no `error` field.
- A bad **login ticket** (`/authorize?login_ticket=…`, the second leg of
  `/co/authenticate`) returns `403` with a plain `message` such as
  `Ticket not found`, `Session not found`, `Invalid client` or `Invalid realm`.

### Errors specific to `prompt=none`

Silent authentication never shows UI, so anything that would need the user
returns an error instead of tokens:

| Code               | Meaning                                                                                                                                                        |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login_required`   | No usable session — the user must authenticate interactively                                                                                                   |
| `consent_required` | A third-party client requested scopes the stored grant doesn't cover ([Third-party client consent](/features/authentication-flows#third-party-client-consent)) |

Both should be handled by falling back to an interactive `/authorize` redirect.

### Errors specific to Dynamic Client Registration

`/oidc/register` follows [RFC 7591](/standards/rfc-7591):

| Code                      | Meaning                                               |
| ------------------------- | ----------------------------------------------------- |
| `invalid_client_metadata` | A registration field is invalid or unsupported        |
| `invalid_redirect_uri`    | One of the supplied `redirect_uris` is not acceptable |

### Other endpoint-specific codes

| Code                        | Meaning                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| `invalid_token`             | The bearer token presented to `/userinfo` (or another protected endpoint) is invalid or expired |
| `unsupported_response_mode` | The `response_mode` requested at `/authorize` is not supported                                  |
| `connection_not_found`      | The requested `connection` does not exist on the tenant                                         |
| `strategy_error`            | The upstream identity provider for the connection returned an error                             |

## Management API error codes

These were captured from a live Auth0 tenant; AuthHero returns the same status,
`message` and `errorCode`. Auth0's messages aren't consistent (some end in a
period, some don't), and AuthHero keeps them exactly as Auth0 sends them.

### Not found (404)

| Resource                        | `message`                                                   | `errorCode`                  |
| ------------------------------- | ----------------------------------------------------------- | ---------------------------- |
| User                            | `The user does not exist.`                                  | `inexistent_user`            |
| Users (bulk role assignment)    | `One or more of the users do not exist.`                    | `inexistent_user`            |
| Client                          | `The client does not exist` (PATCH: with a trailing period) | `inexistent_client`          |
| Connection                      | `The connection does not exist`                             | `inexistent_connection`      |
| Resource server                 | `The resource server does not exist`                        | `inexistent_resource_server` |
| Resource server (by `audience`) | `No resource with identifier {audience}`                    | `inexistent_resource_server` |
| Client grant                    | `The grant does not exist.`                                 | `inexistent_client_grant`    |
| Log                             | `The log does not exist.`                                   | `inexistent_log`             |
| Job                             | `The job does not exist`                                    | `inexistent_job`             |
| Custom domain                   | `The custom domain {id} does not exist`                     | `inexistent_custom_domain`   |
| Signing key                     | `The key with key ID "{kid}" was not found.`                | `inexistent_tenant_key`      |
| Hook                            | `Error: Hook does not exist`                                | `HookDoesNotExist`           |
| Guardian enrollment             | `Enrollment not found`                                      | `enrollment_not_found`       |

Deleting a user, client, connection, resource server or client grant that
doesn't exist returns `204`, as in Auth0. Deleting a missing role or
organization returns `404`.

### Validation (400)

| Failure        | `message` prefix            | `errorCode`            |
| -------------- | --------------------------- | ---------------------- |
| Request body   | `Payload validation error:` | `invalid_body`         |
| Query string   | `Query validation error:`   | `invalid_query_string` |
| Path parameter | `Path validation error:`    | `invalid_uri`          |

The detail follows Auth0's wording, for example
`Payload validation error: 'Missing required property: name'.` or
`Query validation error: 'Value 1000 is greater than maximum 100' on property per_page.`
Several failures are joined with `(also)`. Auth0 also appends each
property's schema description in parentheses; AuthHero does not.

### Authentication (401 / 403)

| Case                  | Status | `message`                                         | `errorCode`          |
| --------------------- | ------ | ------------------------------------------------- | -------------------- |
| Token lacks the scope | 403    | `Insufficient scope, expected any of: read:users` | `insufficient_scope` |

### Conflict (409)

| Case                              | `message`                                              | `errorCode`                |
| --------------------------------- | ------------------------------------------------------ | -------------------------- |
| User already exists               | `The user already exists.`                             | `auth0_idp_error`          |
| Resource server identifier in use | `A resource server already exists with identifer {id}` | `resource_server_conflict` |

(The `identifer` misspelling is Auth0's; it is kept so the message matches.)

### AuthHero extensions

These are the places where AuthHero returns something Auth0 doesn't. Clients
written against Auth0 are unaffected, since they never receive these codes
from Auth0.

**`errorCode` added where Auth0 sends none.** The `message` is still Auth0's:

| Case                     | `message`                                           | Added `errorCode`         |
| ------------------------ | --------------------------------------------------- | ------------------------- |
| Role not found           | `The role does not exist.` (PATCH: `No such role.`) | `inexistent_role`         |
| Organization not found   | `No organization found by that id or name`          | `inexistent_organization` |
| Action not found         | `That action does not exist.`                       | `inexistent_action`       |
| Organization name in use | `An organization with this name already exists.`    | `organization_conflict`   |
| Malformed JSON body      | `Invalid request payload JSON format`               | `invalid_json`            |
| No bearer token          | `Missing authentication` (401)                      | `missing_authentication`  |
| Invalid or expired token | `Invalid token` (401)                               | `invalid_token`           |

**AuthHero-only conditions:**

| Case                                                                 | Status | `message`                        | `errorCode`             |
| -------------------------------------------------------------------- | ------ | -------------------------------- | ----------------------- |
| `tenant-id` names a missing tenant (control-plane tokens only)       | 404    | `The tenant does not exist.`     | `inexistent_tenant`     |
| Resource without a captured Auth0 equivalent (see below)             | 404    | `The <resource> does not exist.` | `inexistent_<resource>` |
| Any other conflict, e.g. deleting an action still bound to a trigger | 409    | Describes the conflict           | `conflict`              |
| Header validation failure                                            | 400    | `Header validation error: …`     | `invalid_headers`       |

The `inexistent_<resource>` codes are: `inexistent_invitation`,
`inexistent_member`, `inexistent_session`, `inexistent_refresh_token`,
`inexistent_grant`, `inexistent_log_stream`, `inexistent_form`,
`inexistent_flow`, `inexistent_identity`, `inexistent_email_template`, `inexistent_email_provider`,
`inexistent_authentication_method`, `inexistent_action_version`,
`inexistent_action_execution`, `inexistent_hook_code`,
`inexistent_failed_event`, `inexistent_migration_source`,
`inexistent_proxy_route`, `inexistent_scim_configuration`,
`inexistent_scim_token`, `inexistent_tenant_operation` and
`inexistent_token_exchange_profile`.

**Behaviour that differs from Auth0:**

- A missing log stream returns `404 inexistent_log_stream`; Auth0 returns
  `500`.
- Path parameters are not format-checked up front, since AuthHero ids don't follow
  Auth0's id formats. A malformed id returns the resource's `404` rather than
  `400 invalid_uri`.
- A bearer value that isn't a JWT returns `401 invalid_token`. Auth0 returns
  `400 Bad HTTP authentication header format` with `errorCode: "Bearer"`.

## Login flow error codes

Errors raised while evaluating an interactive login carry an uppercase `code`
in addition to the message. These are AuthHero-specific and are not OAuth error
values:

| Code                     | Status | Meaning                                                     |
| ------------------------ | ------ | ----------------------------------------------------------- |
| `INVALID_CREDENTIALS`    | 403    | Unknown user or wrong password; deliberately not told apart |
| `USER_BLOCKED`           | 403    | The account is blocked and cannot log in                    |
| `EMAIL_NOT_VERIFIED`     | 403    | The connection requires a verified email address            |
| `TOO_MANY_FAILED_LOGINS` | 403    | Too many recent failed password attempts for this account   |
| `TOO_MANY_REQUESTS`      | 429    | A rate-limit scope was exhausted; may include `Retry-After` |

See [Rate Limiting](overview.md#rate-limiting) for the thresholds behind the
last two.

## Password policy error codes

Password validation (on signup, password reset and invitation acceptance)
reports the **first** unmet requirement, using the tenant's configured policy:

| Code                               | Meaning                                                         |
| ---------------------------------- | --------------------------------------------------------------- |
| `password_too_short`               | Shorter than the configured `min_length`                        |
| `password_missing_lowercase`       | No lowercase letter                                             |
| `password_missing_uppercase`       | No uppercase letter                                             |
| `password_missing_number`          | No digit                                                        |
| `password_missing_special`         | No special character                                            |
| `password_reused`                  | Matches one of the recently used passwords (`password_history`) |
| `password_contains_personal_info`  | Contains the user's name or email                               |
| `password_contains_forbidden_word` | Matches an entry in the tenant's password dictionary            |

On the hosted login screens the code is used to pick a localized message. On
`/dbconnections/signup` the failure surfaces as a `400` whose `message` is the
human-readable policy text.

::: tip Signup does not reveal existing accounts
Signing up with an email that already exists returns
`400 Invalid sign up` — the same response as other invalid signups — rather
than a distinct "user exists" code. This matches Auth0 and is deliberate: it
prevents the endpoint being used to enumerate accounts.
:::
