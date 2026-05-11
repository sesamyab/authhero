---
"authhero": minor
"@authhero/react-admin": patch
---

Connection callback URLs now honor the request's custom domain. Previously `getConnectionCallbackUrl` always returned `${env.ISSUER}callback`, so social/OIDC/OAuth2 connections sent the default-domain redirect_uri upstream even when the user signed in via a custom domain. Now the fallback uses `${customDomain ?? env.ISSUER}callback`, matching Auth0's behavior.

Existing connections with the legacy default-domain callback registered at the upstream IdP should be pinned by setting `options.callback_url` to the exact previously-implicit URL (e.g. `https://auth2.example.com/callback`) — for inherited/control-plane connections this only needs to be set once on the control-plane row and child tenants pick it up via settings inheritance. The override is now editable in the react-admin connection form.
