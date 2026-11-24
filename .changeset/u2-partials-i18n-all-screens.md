---
"authhero": minor
---

Universal login v2: prompt partials now render on more sign-in screens (email/SMS code, passwordless identifier, forgot/reset password, MFA authenticator-app and phone, MFA login options), stored under the prompt and Auth0 screen name (for example `reset-password` → `reset-password-request`). The partials API accepts the new prompts `email-otp-challenge`, `reset-password`, `mfa-otp`, `mfa-phone` and `mfa-login-options`. Screens without stored partials render exactly as before. `self-service-app` and `try-connection-result` are now covered by the custom-text screen map, and tests guard that every registered screen is mapped and that sign-in errors are localized.
