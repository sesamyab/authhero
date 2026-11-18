---
"authhero": minor
"create-authhero": patch
"@authhero/cloudflare-adapter": patch
---

Universal login v2 no longer depends on `/u`. `getUniversalLoginUrl` now defaults to `u2`, flow redirects (`/continue`, account pages) target `/u2`, `/u2/continue` was added, `/u2/*` is allowed as a self-callback, and the u2 link-rewriting was removed. The widget bundle and `client.js` are served from `/widget/*` and `/widget/client.js`; `/u/widget` stays as an alias for one release. Templates now strip either prefix in `widgetHandler`.
