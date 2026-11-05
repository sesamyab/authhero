---
"authhero": minor
"@authhero/adapter-interfaces": minor
"@authhero/admin": patch
---

Post-login actions can require MFA per login with `api.multifactor.enable(provider, { allowRememberBrowser })`, both from code actions and from the `onExecutePostLogin` config hook. The user is challenged after all actions have run and before tokens are issued, with any factor the tenant has enabled. Actions still run only once per login. `"none"` never turns off MFA required by the tenant policy or by another action, and `allowRememberBrowser` is recorded but not acted on yet.

`tenant.mfa.policy` now also accepts Auth0's `all-applications` (enforced like `always`) and `confidence-score`. Adaptive MFA is not supported, so `confidence-score` is enforced like `always`. `PUT /api/v2/guardian/policies` stores `["confidence-score"]` as-is and still stores `["all-applications"]` as `always`. It now rejects unknown policy values with `400`; before, they silently set the policy to `never`. The admin MFA page lists the new values. `customize_mfa_in_postlogin_action` is documented as stored but without effect.
