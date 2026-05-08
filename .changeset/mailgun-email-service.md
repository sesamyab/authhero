---
"authhero": minor
---

Add `MailgunEmailService`, a zero-dependency `EmailServiceAdapter` implementation that posts to the Mailgun HTTP API via `fetch`. Credentials shape (`api_key`, `domain`, `region: "eu" | null`) matches Auth0's Mailgun provider config, so existing Auth0 tenants can migrate without changing their stored values. Sends `template` + `h:X-Mailgun-Variables` so integrators can use Mailgun-side templates named after the auth flows (`auth-code`, `auth-password-reset`, `auth-link`, `auth-verify-email`, `auth-pre-signup-verification`); `html`/`text` are sent as fallback content.
