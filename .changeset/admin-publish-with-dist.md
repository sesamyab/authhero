---
"@authhero/admin": patch
---

Publish the admin UI with its built `dist/`. The release workflow only built `packages/**`, so every published version of `@authhero/admin` shipped without `dist/` and `create-authhero --admin-ui` scaffolds failed to build (`Could not resolve "./admin-index-html"`). Packing now also fails if `dist/` is missing.
