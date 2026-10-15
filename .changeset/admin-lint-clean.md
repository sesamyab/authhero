---
"@authhero/admin": patch
---

Fix the existing ESLint errors in the admin app and scope its lint rules so `pnpm admin lint` passes. `lint` no longer rewrites files; use `lint:fix` for that.
