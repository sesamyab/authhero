---
"authhero": patch
---

Forward `login_hint` to the upstream IdP when Home Realm Discovery routes a login to an enterprise/social connection by email domain. The matched email is added as `login_hint` on the OAuth2/OIDC authorization URL (oauth2, oidc, google-oauth2, microsoft strategies), matching Auth0's HRD behavior so the upstream IdP can pre-fill the user identifier.
