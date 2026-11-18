import { Hono } from "hono";
import { AuthHeroConfig, Bindings, Variables } from "../types";
import {
  BRANDING_ASSET_CACHE_CONTROL,
  isBrandingAssetKind,
} from "../helpers/branding-assets";

/**
 * Public, unauthenticated serving of tenant branding uploads from the storage
 * adapter (used when no dedicated assets domain is configured). Only keys under
 * `tenants/{id}/branding/{kind}/` are served; the key is never a free-form path.
 */
export function createAssetsApp(config: AuthHeroConfig) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

  app.get("/tenants/:tenant_id/branding/:kind/:file", async (ctx) => {
    const { tenant_id, kind, file } = ctx.req.param();
    const storage = config.dataAdapter.storage;
    if (
      !storage ||
      !isBrandingAssetKind(kind) ||
      !/^[A-Za-z0-9_.-]+$/.test(file) ||
      file.includes("..")
    ) {
      return ctx.notFound();
    }

    const obj = await storage.get(
      `tenants/${tenant_id}/branding/${kind}/${file}`,
    );
    if (!obj) return ctx.notFound();

    const headers: Record<string, string> = {
      "Content-Type": obj.contentType ?? "application/octet-stream",
      "Cache-Control": obj.cacheControl ?? BRANDING_ASSET_CACHE_CONTROL,
      // Fonts loaded cross-origin by the login page need CORS.
      "Access-Control-Allow-Origin": "*",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Content-Type-Options": "nosniff",
      // SVGs are untrusted: no scripts, no navigation, no subresources.
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    };
    if (obj.size !== undefined) headers["Content-Length"] = String(obj.size);
    if (obj.etag) headers.ETag = obj.etag;

    return new Response(obj.body, { headers });
  });

  return app;
}
