---
"@authhero/admin": minor
---

Branding preview now renders through the server's own preview endpoint instead of a client-side widget pinned to unpkg 0.41.6. It adds a light/dark toggle (`BrandingPreview` accepts `colorScheme` and `onColorSchemeChange` so the theme form can drive it), OTP, MFA, consent and error screens, and respects the stored template and background image. `WidgetPreview` (prompt partials) loads the widget from the connected server's `/u/widget` and sets data as element properties instead of `dangerouslySetInnerHTML`.
