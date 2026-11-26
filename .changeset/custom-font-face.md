---
"authhero": patch
"@authhero/widget": patch
---

Apply the tenant's custom font when `branding.font.url` / `theme.fonts.font_url` points at a font file.

As in Auth0, the URL is normally a font file (`.woff2`, `.woff`, `.ttf`, `.otf`), but the widget and the u2 pages loaded it with `<link rel="stylesheet">`. The browser downloaded it and threw it away, so the font never applied. A font file is now declared with an `@font-face` for the `ulp-font` family, which the widget stylesheet lists first; the page chrome uses the same family. Any other URL (e.g. a Google Fonts CSS URL) is still loaded as a stylesheet, and its href is no longer HTML-escaped twice on the u2, error and token-info pages.
