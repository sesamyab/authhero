---
"@authhero/adapter-interfaces": minor
"authhero": patch
"@authhero/kysely-adapter": patch
"@authhero/drizzle": patch
"@authhero/aws-adapter": patch
---

Remove `loginSessionBump` from the refresh grant and from `refreshTokens.update`. Nothing resolves through the login session any more, so an exchange no longer extends its `expires_at`. The `login_id` revoke cascade is kept for legacy rows until they have aged out.
