---
"authhero": minor
"@authhero/adapter-interfaces": minor
"@authhero/kysely-adapter": minor
"@authhero/drizzle": minor
"@authhero/aws-adapter": minor
"@authhero/admin": minor
---

Add session transfer tokens (Auth0's Native to Web SSO), so a signed-in user can be carried from one application to another in the same tenant, including between sites on different top-level domains.

An application whose client has `session_transfer.can_create_session_transfer_token` exchanges its refresh token at `POST /oauth/token` with `audience=urn:{domain}:session_transfer` and gets a single-use, 60-second token back in Auth0's response shape (`issued_token_type: urn:auth0:params:oauth:token-type:session_transfer_token`, `token_type: N_A`). The receiving application sends it to `/authorize` as the `session_transfer_token` query parameter or the `auth0_session_transfer_token` cookie, whichever its `session_transfer.allowed_authentication_methods` allows, and the user is logged in without a prompt. A token that is reused, expired, presented from another IP address (`enforce_device_binding`, default `ip`), meant for another organization, or whose parent refresh token is gone falls through to the normal login page and writes a `w` log; it is never an error page. A browser session that belongs to a different user is revoked, and the user is asked to log in.

`session_transfer` on clients is now typed and validated, and the Management API fills in Auth0's defaults when it is written. Beyond Auth0: any application type may create tokens, a token works on every domain of the tenant, `allow_onward_transfer` lets a transferred login pass the session on again, and `trust_forwarded_ip` lets an authenticated confidential client bind the token to the end user's address from the `auth0-forwarded-for` header. Sessions and refresh tokens created from a transfer record where they came from: revoking the parent refresh token ends them unless the sender turned `enforce_cascade_revocation` off, the receiver gets a refresh token only with `allow_refresh_token`, and that refresh token ends with its session while `enforce_online_refresh_tokens` is on. Post-login hooks receive `event.session_transfer_token` and `event.session.session_transfer`.

Admin UI: applications that users log in through get a **Session Transfer** tab with the sending and receiving settings. It warns when tokens are accepted in the URL with no device check.

Adapters: `sessions` and `refresh_tokens` gain a nullable `session_transfer` column (kysely and drizzle migrations included), and `refreshTokens` gains a required `isFamilyActive(tenant_id, family_id)` method, which custom adapters must implement.
