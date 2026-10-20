---
"authhero": minor
"@authhero/saml": minor
---

Implement the SAML IdP single logout endpoint at `/samlp/:client_id/logout` (redirect and POST bindings). It revokes the session identified by the request's `SessionIndex` (or the session cookie), logs `slo`/`flo` with client, user, session and `login_session_id`, and answers with a `LogoutResponse` to `addons.samlp.logout.callback` when configured.
