---
"@authhero/drizzle": patch
"@authhero/kysely-adapter": patch
---

Return theme `fonts` in the nested Auth0 shape (`fonts.body_text.bold` instead of `fonts.body_text_bold`) from `themes.get`, so stored themes pass `themeSchema` validation (e.g. the branding preview endpoint).
