---
"@authhero/react-admin": patch
---

Fix branding URL fields (background image, logo, favicon, font URL) that couldn't be cleared from the admin UI. React-admin's default `TextInput` converts emptied input back to `null`, and `transformBranding` then strips null keys before submitting — so the PATCH body omitted the cleared field, which the server's deep-merge treats as "no change". The cleared value silently persisted. The clearable URL inputs in `branding/edit.tsx` and `branding/ThemesTab.tsx` now emit `""` instead of `null`, matching Auth0's PATCH semantics (omitted key = no change, empty string = clear).
