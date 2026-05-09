---
"authhero": minor
"@authhero/adapter-interfaces": minor
"@authhero/kysely-adapter": minor
"@authhero/drizzle": minor
"@authhero/aws-adapter": minor
---

Add Auth0-compatible email-template management (`/api/v2/email-templates`).

Tenants can now `POST/GET/PUT/PATCH` template overrides keyed by Auth0's
template names (`reset_email`, `verify_email`, `verify_email_by_code`,
`reset_email_by_code`, `welcome_email`, etc.). Bodies are HTML+Liquid; at send
time the auth flows look up the override (or fall back to a bundled default
authored as react-email JSX components and pre-rendered to HTML at build time)
and render it with `liquidjs` before handing off to `EmailServiceAdapter.send()`.
Tenants on Mailgun-side templates keep working — the legacy template name and
`data` dict are still passed through unchanged.

Schema: new `email_templates` table keyed by `(tenant_id, template)` with the
Auth0 fields (`body`, `from`, `subject`, `syntax`, `resultUrl`,
`urlLifetimeInSeconds`, `includeEmailInRedirect`, `enabled`). Both the Kysely
and Drizzle adapters ship parallel implementations.
