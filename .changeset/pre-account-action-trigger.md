---
"authhero": minor
"@authhero/adapter-interfaces": minor
"@authhero/admin": minor
---

Add the `pre-account-action` trigger (AuthHero extension, issue #1700). It runs when a user starts a self-service account operation (change email, update profile, password reset, MFA or passkey enrollment and removal, unlinking an identity, deleting the account) and lets an Action send the user elsewhere with `api.redirect.sendUserTo(url)` or stop the operation with `api.access.deny(reason)`. Use it for users whose identity is owned by another system, for example users who sign in through custom token exchange. Configure it with code Actions bound to the trigger or the `onExecutePreAccountAction` config hook.
