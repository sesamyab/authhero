---
"@authhero/kysely-adapter": patch
"@authhero/cloudflare-adapter": patch
---

Fix `/analytics/*` endpoints returning `Internal Server Error`.

- `@authhero/cloudflare-adapter`: `createAdapters` now also creates an `analytics` adapter (backed by the Analytics Engine SQL API) when `analyticsEngineLogs` is configured. Previously only `logs` was wired, so consumers that spread the kysely adapter were silently falling through to the kysely analytics path.
- `@authhero/kysely-adapter`: the analytics time-bucketing SQL used SQLite-only functions (`datetime`, `strftime`) which MySQL/PlanetScale rejected with a 1064 syntax error. The adapter now detects the dialect at runtime and emits portable expressions for UTC, plus MySQL-specific expressions for non-UTC timezones.
