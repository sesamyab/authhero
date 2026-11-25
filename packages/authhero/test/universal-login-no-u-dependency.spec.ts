import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  getUniversalLoginUrl,
  getSelfCallbackWildcards,
} from "../src/variables";
import { createWidgetAssetRoutes } from "../src/routes/universal-login/widget-assets";
import { getTestServer } from "./helpers/test-server";

const env = { ISSUER: "https://auth.example.com/" } as any;

describe("universal login v2 does not depend on /u", () => {
  it("getUniversalLoginUrl defaults to u2", () => {
    expect(getUniversalLoginUrl(env)).toBe("https://auth.example.com/u2/");
    expect(getUniversalLoginUrl(env, undefined, "u")).toBe(
      "https://auth.example.com/u/",
    );
    expect(getUniversalLoginUrl(env, "login.example.com")).toBe(
      "https://login.example.com/u2/",
    );
  });

  it("self callback wildcards cover /u/* and /u2/*", () => {
    const wildcards = getSelfCallbackWildcards(env);
    expect(wildcards).toContain("https://auth.example.com/u/*");
    expect(wildcards).toContain("https://auth.example.com/u2/*");
  });

  it("serves the widget and client.js from /widget, with legacy handler compat", async () => {
    const seen: string[] = [];
    const routes = createWidgetAssetRoutes({
      widgetHandler: (c) => {
        seen.push(c.req.path);
        return c.text("widget");
      },
    } as any);
    const app = new Hono().route("/", routes);

    const widget = await app.request("/widget/authhero-widget.esm.js");
    expect(widget.status).toBe(200);
    expect(await widget.text()).toBe("widget");
    // Handlers written for /u/widget keep working.
    expect(seen).toEqual(["/u/widget/authhero-widget.esm.js"]);

    const client = await app.request("/widget/client.js");
    expect(client.status).toBe(200);
    expect(client.headers.get("content-type")).toContain("javascript");
  });

  it("gives the widget handler the host context variables on /widget/*", async () => {
    const seen: unknown[] = [];
    const routes = createWidgetAssetRoutes({
      widgetHandler: (c) => {
        seen.push(c.var.tenant_id);
        return c.text("widget");
      },
    } as any);
    const app = new Hono<{ Variables: { tenant_id: string } }>();
    app.use("*", async (c, next) => {
      c.set("tenant_id", "tenantId");
      await next();
    });
    app.route("/", routes);

    const res = await app.request("/widget/authhero-widget.esm.js");
    expect(res.status).toBe(200);
    expect(seen).toEqual(["tenantId"]);
  });

  it("sends the legacy CORS headers on /widget/*", async () => {
    const routes = createWidgetAssetRoutes({
      widgetHandler: (c) => c.text("widget"),
    } as any);
    const app = new Hono().route("/", routes);

    const res = await app.request("/widget/authhero-widget.esm.js", {
      headers: { Origin: "https://example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");

    const preflight = await app.request("/widget/authhero-widget.esm.js", {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.com",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-methods")).toContain(
      "GET",
    );

    const client = await app.request("/widget/client.js", {
      headers: { Origin: "https://example.com" },
    });
    expect(client.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("serves both widget URLs from a sub-app-only composition", async () => {
    const { universalApp, env } = await getTestServer();
    const host = new Hono()
      .route(
        "/",
        createWidgetAssetRoutes({
          dataAdapter: env.data,
          widgetHandler: (c) => c.text(`widget:${c.req.path}`),
        }),
      )
      .route("/u", universalApp);

    expect(await (await host.request("/widget/a.js", {}, env)).text()).toBe(
      "widget:/u/widget/a.js",
    );
    expect((await host.request("/widget/client.js", {}, env)).status).toBe(200);
    // The legacy client.js route on the real universalApp is still mounted.
    expect((await host.request("/u/js/client.js", {}, env)).status).toBe(200);
  });

  it("mounts /widget, the /u/widget alias and /u2/continue on the app", async () => {
    const { app, env } = await getTestServer({
      widgetHandler: (c) => c.text(`widget:${c.req.path}`),
    });
    expect((await app.request("/widget/client.js")).status).toBe(200);
    expect((await app.request("/u/js/client.js")).status).toBe(200);

    const neutral = await app.request("/widget/authhero-widget.esm.js");
    expect(await neutral.text()).toBe(
      "widget:/u/widget/authhero-widget.esm.js",
    );
    const legacy = await app.request("/u/widget/authhero-widget.esm.js");
    expect(await legacy.text()).toBe("widget:/u/widget/authhero-widget.esm.js");

    // A PENDING session is not awaiting continuation: the u2 handler sends
    // the browser to the u2 identifier screen (the catch-all would 400).
    const loginSession = await env.data.loginSessions.create("tenantId", {
      csrf_token: "csrf",
      authParams: { client_id: "clientId" },
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    } as any);
    const res = await app.request(
      `/u2/continue?state=${loginSession.id}`,
      { headers: { "tenant-id": "tenantId" } },
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `/u2/login/identifier?state=${encodeURIComponent(loginSession.id)}`,
    );
  });
});
