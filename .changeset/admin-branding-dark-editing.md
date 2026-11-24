---
"@authhero/admin": minor
---

Branding editor: simple/advanced themes view (six core colours, the rest derived), a light/dark switch that edits the optional dark overrides (`colors_dark`, `widget.logo_url_dark`, `page_background.*_dark`) with a "Generate dark from light" action, WCAG contrast warnings, colour validation in `ColorInput`, a dark favicon field, and labels explaining that the theme wins over the Style tab. Clearing a field now actually saves (sent as an empty string, which also resets a dark override to derived).
