---
"authhero": minor
"@authhero/react-admin": patch
---

Connection callback URLs now match Auth0's default. Previously `getConnectionCallbackUrl` always returned `${env.ISSUER}callback` regardless of the request host. The fallback now returns `${customDomain ?? env.ISSUER}login/callback` — honoring custom domains and using Auth0's `/login/callback` path instead of the legacy `/callback`.

Existing connections with the legacy `/callback` URL registered at the upstream IdP should be pinned by setting `options.callback_url` to the exact previously-implicit URL (e.g. `https://auth2.example.com/callback`) before deploying — otherwise the upstream IdP will reject the new redirect_uri. For inherited/control-plane connections this only needs to be set once on the control-plane row; child tenants pick it up via settings inheritance. The override is now editable in the react-admin connection form. The legacy `/callback` route remains mounted (deprecated) so pinned URLs keep working.
