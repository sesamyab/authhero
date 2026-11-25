import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { AuthHeroConfig, Bindings, Variables } from "../../types";
import { clientJs } from "../../client/client-bundle";

/**
 * Neutral location for the widget bundle and the shared client script, so the
 * universal-login pages don't depend on the legacy /u prefix.
 */
export const WIDGET_ASSET_PATH = "/widget";
export const WIDGET_CLIENT_JS_PATH = `${WIDGET_ASSET_PATH}/client.js`;

/** Legacy path that existing `widgetHandler` rewriteRequestPath functions strip. */
const LEGACY_WIDGET_PATH = "/u/widget";

/**
 * Serves `/widget/client.js` and `/widget/*`. The configured `widgetHandler`
 * is invoked with the request path rewritten to the legacy `/u/widget/*`
 * form, so handlers that do `p.replace("/u/widget", "")` keep working as well
 * as handlers written for the neutral path.
 */
export function createWidgetAssetRoutes(config: AuthHeroConfig) {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

  // Same CORS policy as the legacy /u/widget/* route, kept inside this router
  // so standalone mounts of the asset routes get it too.
  app.use(
    `${WIDGET_ASSET_PATH}/*`,
    cors({ origin: "*", allowMethods: ["GET", "HEAD"] }),
  );

  app.get(WIDGET_CLIENT_JS_PATH, (ctx: Context) =>
    ctx.text(clientJs, 200, {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
    }),
  );

  const handler = config.widgetHandler;
  if (!handler) {
    app.get(`${WIDGET_ASSET_PATH}/*`, (ctx: Context) =>
      ctx.json(
        {
          error: "widget_not_configured",
          message:
            "The AuthHero widget is not configured. Provide a widgetHandler in your AuthHeroConfig to serve widget files from @authhero/widget package.",
        },
        404,
      ),
    );
    return app;
  }

  // The handler runs in an inner app so it sees the legacy /u/widget path.
  // That inner request gets a fresh Hono context, so copy the variables the
  // host middleware set on the outer context: the handler then sees the same
  // `ctx.var` on /widget/* as it does on /u/widget/*.
  const outerContexts = new WeakMap<Request, Context>();
  const inner = new Hono();
  inner.use("*", async (c, next) => {
    const outer = outerContexts.get(c.req.raw);
    if (outer) {
      for (const [key, value] of Object.entries(outer.var)) {
        c.set(key as never, value as never);
      }
    }
    await next();
  });
  inner.get(`${LEGACY_WIDGET_PATH}/*`, handler);
  app.get(`${WIDGET_ASSET_PATH}/*`, (ctx: Context) => {
    const url = new URL(ctx.req.url);
    url.pathname =
      LEGACY_WIDGET_PATH + url.pathname.slice(WIDGET_ASSET_PATH.length);
    // executionCtx throws outside a Workers-style runtime.
    let executionCtx: Parameters<typeof inner.fetch>[2];
    try {
      executionCtx = ctx.executionCtx;
    } catch {
      executionCtx = undefined;
    }
    const request = new Request(url, ctx.req.raw);
    outerContexts.set(request, ctx);
    return inner.fetch(request, ctx.env, executionCtx);
  });
  return app;
}
