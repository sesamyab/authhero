---
"authhero": minor
---

The branding preview endpoint (`POST /api/v2/branding/templates/universal-login/preview`) supports the `otp`, `mfa`, `consent` and `error` sample screens, and an explicit `branding.dark_mode` in the request now overrides the viewer's `ah-dark-mode` cookie. `/u/widget/*` is served with permissive CORS so the admin can load the widget from another origin.
