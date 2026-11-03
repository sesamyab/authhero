---
"@authhero/admin": patch
"@authhero/cloudflare-adapter": patch
"@authhero/multi-tenancy": patch
---

- Admin: only verify an Action before saving when the server enforces verification (`verification_required`), and treat a server without the generation route (authhero before 9.28) as having no generation options instead of blocking saves or showing an error.
- Correct stale peer dependency ranges: `@authhero/cloudflare-adapter` now requires `authhero@^9.28.0` and `@authhero/multi-tenancy@^15.4.0`, and `@authhero/multi-tenancy` requires `@authhero/adapter-interfaces@^4.25.0` (it listed a non-existent `^14.0.0`).
