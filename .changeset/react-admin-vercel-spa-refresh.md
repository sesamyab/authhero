---
"@authhero/react-admin": patch
---

Fix blank spinner on refresh of deep URLs in production.

The Vite build emits relative asset paths (`./assets/index-*.js`) so the same bundle can be served from any base path. On Vercel — where nothing injects a `<base>` — refreshing a deep URL like `/:tenantId/users/abc` made the browser resolve `./assets/...` against the current path, hit the SPA catch-all rewrite, and get served `index.html` instead of the JS bundle, leaving the page stuck on the static loading spinner. Added `<base href="/" />` to `index.html` so the relative paths anchor to the origin. The Docker entrypoint still injects `<base href="/admin/" />` ahead of this one, and per HTML spec only the first `<base>` element is honored, so the `/admin` deployment is unaffected.
