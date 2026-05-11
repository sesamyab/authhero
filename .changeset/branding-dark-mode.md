---
"authhero": minor
"@authhero/adapter-interfaces": minor
"@authhero/kysely-adapter": minor
"@authhero/drizzle": minor
---

Add `branding.dark_mode` and rebuild the Universal Login custom-template pipeline on modern chip chrome with fine-grained slot tokens.

**`branding.dark_mode`** — AuthHero-specific (Auth0 has no equivalent).
- `brandingSchema` gains an optional `dark_mode` field accepting `"dark"`, `"light"`, or `"auto"`. Persisted in a new `dark_mode` column on the `branding` table (kysely + drizzle migrations included).
- The universal login pages honor it as the initial color scheme when no `ah-dark-mode` cookie is set. The per-user cookie still overrides at runtime.

**Universal Login custom-template pipeline rewrite.**
The legacy `.page-footer` chrome (used only when a tenant uploaded a custom Liquid template) is gone. Both the default page and tenant-customized pages now share the modern chip chrome from `WidgetPage`, with the body content driven by slot tokens.

- New slot tokens, scoped to the body fragment:
  - `{%- auth0:widget -%}` — widget mount (required)
  - `{%- authhero:logo -%}` — top-left logo chip
  - `{%- authhero:settings -%}` — top-right chip combining dark-mode toggle + language picker
  - `{%- authhero:dark-mode-toggle -%}` — dark-mode button only
  - `{%- authhero:language-picker -%}` — language picker only
  - `{%- authhero:powered-by -%}` — bottom-left powered-by chip
  - `{%- authhero:legal -%}` — bottom-right legal chip
- **Breaking:** The `PUT /api/v2/branding/templates/universal-login` body is now a body fragment (not a full HTML document). It only needs to include `{%- auth0:widget -%}`. The legacy `{%- auth0:head -%}` / `{%- auth0:footer -%}` slots no longer expand — tenants on the old format must migrate to the new slot tokens. Page shell (CSS, dark-mode runtime, background tint, body layout) is now fixed by AuthHero, not part of the tenant template.
- `GET /api/v2/branding/templates/universal-login` returns the AuthHero default body (instead of 404) when no custom template is stored, so tenants can fetch it as a starting point.
- The react-admin universal-login tab is updated for the new tokens, validation, and documentation.
