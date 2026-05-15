---
"authhero": patch
---

Fix "Illegal invocation" error when sending email via Mailgun on Cloudflare Workers. The global `fetch` was being called with `this` bound to the service instance instead of `globalThis`.
