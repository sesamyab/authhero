---
"create-authhero": patch
---

Scaffold Cloudflare templates with `@cloudflare/workers-types@^5`. `wrangler@4.157` declares a peer dependency on `^5.20261103.1`, so the previous `^4.0.0` range made `npm install` fail with ERESOLVE right after scaffolding.
