---
"@authhero/adapter-interfaces": minor
"@authhero/cloudflare-adapter": minor
"authhero": minor
"@authhero/admin": minor
---

Branding file uploads (#1738). New optional `StorageAdapter` (`data.storage`) with an R2 implementation in `@authhero/cloudflare-adapter` (`storage: { bucket, publicBaseUrl? }`). `POST /api/v2/branding/uploads/{kind}` validates type, size and content (SVG is checked and served with a restrictive CSP), stores objects under `tenants/{tenant_id}/branding/{kind}/`, and returns a URL. Files are served publicly with cache headers and CORS at `/assets/...`; `publicBaseUrl` only changes the URL returned by the upload API (the `/assets` route stays mounted, and SVGs always use it for its CSP). The admin branding page gets upload buttons for logo, favicon, powered-by logo, font and background image.
