---
"authhero": minor
"@authhero/adapter-interfaces": minor
"@authhero/admin": patch
---

Users can now tick "Remember this device for N days" on the TOTP and SMS challenge screens, and later logins from that browser skip the MFA challenge for that period (#1670). The option appears only when everything that requires MFA for the login allows it: the tenant policy through the new `tenant.mfa.allow_remember_browser` setting (off by default, so nothing changes until a tenant turns it on), and a post-login action through `api.multifactor.enable(provider, { allowRememberBrowser: true })`. `tenant.mfa.remember_browser_lifetime_in_days` sets the period (1–365, default 30); lowering it also shortens devices remembered earlier.

The browser holds a random token in an `HttpOnly` `{tenant_id}-mfa-remember-browser` cookie; only its SHA-256 is stored, as a new `mfa_remember_browser` code type (no migration). A remembered browser satisfies MFA but is not MFA: no `amr` claim is issued for those logins and the browser session is not marked as MFA-complete. It never skips enrollment, and silent authentication accepts it when the tenant allows remembering. `POST /api/v2/users/{id}/multifactor/actions/invalidate-remember-browser` (Auth0) makes every browser remembered for a user complete MFA again. The admin MFA page has the two new settings.
