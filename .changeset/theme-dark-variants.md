---
"@authhero/adapter-interfaces": minor
"@authhero/drizzle": minor
"@authhero/kysely-adapter": minor
"@authhero/aws-adapter": minor
"@authhero/widget": minor
"authhero": minor
---

Optional dark-scheme overrides for themes (#1740, part of #1508). New AuthHero-only fields, all optional and ignored by Auth0-shaped clients: `colors_dark` (partial of `colors`), `widget.logo_url_dark`, `page_background.background_color_dark`, `page_background.background_image_url_dark`, and `branding.favicon_url_dark`. Existing payloads keep validating. The kysely adapter gets a migration (nullable columns on `themes`, `favicon_url_dark` on `branding`); drizzle ships `0022_theme_dark.sql`; DynamoDB stores `colors_dark` as JSON.

The universal login page now resolves dark values as: explicit dark field, then the derived dark palette, then the light value. The page background, logo and form-control `color-scheme` are chosen by server-rendered CSS (no flash); black provider icons (Apple, GitHub) are inverted in dark. The derived dark palette now keeps the tenant's brand link colour (lightened to stay readable) instead of falling back to a stock blue. When a theme sets `widget.logo_url`, the page's logo chip uses it ahead of `branding.logo_url`, as the widget already did.
