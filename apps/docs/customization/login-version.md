# Login version (/u and /u2)

AuthHero serves two universal logins: the widget login at `/u2` and the classic login at `/u`. The classic login is deprecated and will be removed in 1.0.

## How the version is chosen

1. **Application override.** `client_metadata.universal_login_version` on the application: `"2"` → `/u2`, `"1"` → `/u`. Set it on the application's details tab in the admin ("Login version"), or leave it on "Inherit from tenant".
2. **Tenant flag.** Otherwise the tenant flag `flags.universal_login_version` decides: `"2"` → `/u2`, `"1"` or unset → `/u`. Toggle it in the admin under Settings → Feature Flags ("Use the widget login (/u2)"), or with `PATCH /api/v2/tenants/settings`.

Existing tenants have no flag, so nothing changes on upgrade: each application keeps the version its own override gives it. New tenants created by `seed` or the multi-tenancy `POST /tenants` get `"2"`.

Device-flow and `/connect` logins always use `/u2`.

## Migrating a tenant

The `login-migration` CLI in the `authhero` package works against a kysely database. Set `DATABASE_URL` to a PlanetScale URL or a SQLite file path:

```bash
DATABASE_URL=... pnpm authhero login-migration count
```

- `count` lists the tenants that still have applications on `/u`, with totals.
- `check --tenant <id>` (or `--all`) prints the checklist for a tenant. Add `--base-url https://login.example.com` to also check that the widget bundle is served.
- `flip --tenant <id>` sets the tenant flag to `"2"`. Applications pinned to `"1"` stay on `/u` and are listed. Use `--dry-run` first.
- `rollback --tenant <id>` removes the tenant flag again. Application overrides are never changed, so this restores the earlier routing when the tenant had no flag or `"1"` before `flip`. If it had another value, note the `from` value that `flip` prints and set it back yourself.

### Checklist

`check` reports these items:

- **Tenant setting and overrides.** Applications pinned to `/u`, or with an unrecognised value.
- **Theme.** Without a stored theme `/u2` renders the built-in default theme.
- **Custom pages.** Applications with `custom_login_page` or `form_template`, which `/u2` does not render. Also the tenant's universal login template, which only `/u2` renders, so it takes effect when you flip.
- **Prompt settings and customizations.** `identifier_first`, `password_first`, and the number of custom text entries and prompt partials to review on `/u2`.
- **Terms URL.** Applications without a terms link (`tos_uri`, `termsAndConditionsUrl`, or the branding `terms_url`).
- **Widget.** With `--base-url`, whether `/widget/authhero-widget.esm.js` is served (through `widgetHandler` or static assets).
