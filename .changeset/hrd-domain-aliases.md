---
"authhero": minor
"@authhero/adapter-interfaces": minor
---

Add Home Realm Discovery (HRD) via `domain_aliases` on connection options. When a user enters their email at the universal-login identifier prompt, authhero now looks for an enterprise/social connection whose `options.domain_aliases` contains the email's domain and, on a match, redirects straight to that IdP — skipping the password / OTP step.

- New optional field: `Connection.options.domain_aliases: string[]` (Auth0-compatible, stored in the existing `options` JSON column — no DB migration).
- Domain matching is case-insensitive and exact (no wildcards).
- Only enterprise/social strategies are eligible; HRD ignores `domain_aliases` set on `Username-Password-Authentication`, `email`, or `sms` connections.
- Domain match wins over an existing local-password user with the same email.
- The react-admin connection edit form now exposes a Domain Aliases input on non-database connections.
