---
"authhero": minor
"@authhero/adapter-interfaces": minor
"@authhero/drizzle": minor
"@authhero/kysely-adapter": minor
"@authhero/aws-adapter": minor
"@authhero/admin": minor
---

Developer app invites (#1776): an outside developer can register and update their own OAuth app through time-limited links, without an account.

- **Invites.** `POST /api/v2/client-registration-tokens` accepts a `preset` (`native`, `spa`, `regular_web`) with a `name`, optional `connections` and `is_first_party`, and returns a setup link in `ticket`. Presets pin the app type, grant types (`authorization_code`, `refresh_token`), client authentication (none for native and single-page apps, `client_secret_post` for web apps) and PKCE with S256. Invite and edit links last 7 days by default, at most 30.
- **Setup page.** `/u2/self-service/app` registers the app (invite link) or updates it (edit link), with the tenant's branding and translations in every shipped locale. The client secret of a web app is shown once.
- **Edit links.** `POST /api/v2/clients/{id}/registration-ticket` returns an edit link and revokes the client's previous ones. It also works for clients created by hand. Through an edit link, and for every invite-created app, updates are limited to the name, logo, callback, logout and web origin URLs and contact details, and `DELETE /oidc/register/{id}` returns `405`.
- **Invite management.** `GET /api/v2/client-registration-tokens` (with `type`, `source`, `client_id`), `GET /{id}` and `POST /{id}/revoke`, with the new scopes `read:client_registration_tokens` and `delete:client_registration_tokens`. Tokens and hashes are never returned.
- **Registration fixes.** Public clients (`token_endpoint_auth_method: none`) no longer get a client secret. RFC 7592 `PUT` keeps a constrained field the caller omits instead of resetting it. Registration accepts `application_type`, `post_logout_redirect_uris` and `web_origins`. Script and data URL schemes are rejected as redirect URIs; private-use schemes without a host (`com.example.app:/callback`) are accepted.
- **Management API.** `DELETE /api/v2/clients/{id}` revokes the client's registration tokens.
- **Storage.** `client_registration_tokens` gains `name`, `created_by` and `source`, plus `list()` on the adapter and an optional `client_id` on `markUsed()`. Migrations: drizzle `0023_client_registration_token_invites`, kysely `2026-11-23T12:00:00_client_registration_token_invites`.
- **Admin UI.** "Invite a developer" on Applications, an App invites list, a "Registered by invite" badge, and a Developer Access tab with edit links and revoke.
- Ticket ids of self-service links (SSO tickets and app links) share one helper, and `ticket` query parameters are redacted from logs.
