---
"authhero": minor
"create-authhero": patch
"@authhero/cloudflare-adapter": patch
---

Universal login v2 no longer depends on `/u`. `getUniversalLoginUrl` now defaults to `u2`, flow redirects (`/continue`, account pages) target `/u2`, `/u2/continue` was added, `/u2/*` is allowed as a self-callback, and the u2 link-rewriting was removed. The widget bundle and `client.js` are served from `/widget/*` and `/widget/client.js`; `/u/widget` stays as an alias for one release. On `/widget/*` the `widgetHandler` sees the same context variables and gets the same CORS headers as on `/u/widget/*`. Without a `widgetHandler`, `/widget/*` redirects to `/u/widget/*`, so deployments that serve the widget as static files under `/u/widget/` need no change; copy the files to `/widget/` as well before `/u` is removed. Templates now strip either prefix in `widgetHandler`.
