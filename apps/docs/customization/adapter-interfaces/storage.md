---
title: Storage Adapter (Branding Uploads)
description: Store tenant branding files (logo, favicon, background, font) with the optional StorageAdapter, including the Cloudflare R2 setup.
---

# Storage Adapter (Branding Uploads)

The optional `storage` adapter lets admins upload branding files (logo, favicon, powered-by logo, background image and font) instead of pasting URLs. An upload returns a URL that goes into the existing branding URL field, so the branding schema is unchanged and external URLs keep working.

Without a `storage` adapter, the upload endpoint returns `501` and the admin UI behaves as before.

## Interface

```ts
interface StorageAdapter {
  put(
    key: string,
    body: ArrayBuffer | Uint8Array,
    options: { contentType: string; cacheControl?: string },
  ): Promise<void>;
  get(key: string): Promise<{
    body: ReadableStream;
    contentType?: string;
    cacheControl?: string;
    size?: number;
    etag?: string;
  } | null>;
  delete(key: string): Promise<void>;
  // Public URL when files are served from a dedicated assets domain, otherwise undefined.
  getPublicUrl(key: string): string | undefined | Promise<string | undefined>;
}
```

Set it as `data.storage`. To support S3 or local disk, implement these four methods; nothing in `authhero` needs to change.

## Cloudflare R2

All tenants share one bucket. This is a one-time setup per environment, nothing is provisioned per tenant.

1. Create the bucket: `wrangler r2 bucket create authhero-assets`
2. Bind it in `wrangler.toml`:

   ```toml
   [[r2_buckets]]
   binding = "ASSETS"
   bucket_name = "authhero-assets"
   ```

3. Pass it to the Cloudflare adapter and use the resulting `storage` in your data adapter:

   ```ts
   const cloudflare = createAdapters({
     // ...existing config
     storage: { bucket: env.ASSETS },
   });

   const dataAdapter = { ...baseAdapters, storage: cloudflare.storage };
   ```

## How files are served

By default the auth server serves files itself at `/assets/tenants/{tenant_id}/branding/{kind}/{file}`. The route is public and sets immutable cache headers, `Access-Control-Allow-Origin: *` (fonts are loaded cross-origin), `nosniff` and a restrictive `Content-Security-Policy`. The bucket can stay private and no extra configuration is needed.

To serve from one shared assets domain instead, attach a custom domain to the bucket and set `publicBaseUrl`:

```ts
storage: { bucket: env.ASSETS, publicBaseUrl: "https://assets.example.com" }
```

- `publicBaseUrl` only changes the URL returned by the upload API; `/assets` stays mounted.
- Fonts need an R2 CORS policy allowing `GET` from your login origins. If you can't set one, omit `publicBaseUrl`.
- SVG files always use the `/assets` URL so the restrictive CSP applies. They are still stored in the bucket, so they are also reachable at `publicBaseUrl/<key>` without that CSP. Add a Cloudflare Transform Rule on the assets domain that sets `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox` (and `X-Content-Type-Options: nosniff`) for `.svg` paths, or don't expose the bucket publicly.

Stored URLs are plain URLs, so you can later point per-tenant subdomains at the `tenants/{tenant_id}/` prefix, or move a tenant to its own bucket, by copying objects and updating the URL.

## Keys and lifecycle

Objects are stored as `tenants/{tenant_id}/branding/{kind}/{uuid}.{ext}`, where `kind` is `logo`, `favicon`, `powered_by_logo`, `background` or `font`. The tenant id comes from the authenticated request. Every upload gets a new random name, so URLs are immutable and cacheable for a year. Replacing a file does not delete the previous object.

## Limits

| Kind                      | Types                          | Max size |
| ------------------------- | ------------------------------ | -------- |
| `logo`, `powered_by_logo` | PNG, JPEG, WebP, GIF, SVG      | 2 MB     |
| `favicon`                 | PNG, JPEG, WebP, GIF, SVG, ICO | 512 KB   |
| `background`              | PNG, JPEG, WebP, SVG           | 5 MB     |
| `font`                    | WOFF2, WOFF, TTF, OTF          | 2 MB     |

The file's bytes must match its declared type. SVGs must have an `<svg>` root and are rejected if they contain scripts, `foreignObject`, event handlers, entities or references to external resources.

## API

`POST /api/v2/branding/uploads/{kind}` with a multipart `file` field and the `update:branding` scope returns:

```json
{
  "url": "...",
  "key": "tenants/acme/branding/logo/<uuid>.png",
  "content_type": "image/png",
  "size": 1234
}
```
