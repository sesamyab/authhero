---
"@authhero/admin": patch
---

Fix all ESLint errors in the admin app, including replacing every explicit `any` with a real type, so `pnpm admin lint` passes. `lint` no longer rewrites files; use `lint:fix` for that.
