import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  getUniversalLoginUrl,
  getSelfCallbackWildcards,
} from "../src/variables";
import { createWidgetAssetRoutes } from "../src/routes/universal-login/widget-assets";
import { getRedirectUrl } from "../src/hooks/formhooks";
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

  it("form hook redirects target /u2", () => {
    expect(getRedirectUrl("account", undefined, "s")).toBe(
      "/u2/account?state=s",
    );
  });

  it("serves the widget and client.js from /widget, with legacy handler compat", async () => {
    const seen: string[] = [];
    const routes = createWidgetAssetRoutes({
      widgetHandler: (c: any) => {
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

  it("mounts /widget and the /u/widget alias on the app, and /u2/continue", async () => {
    const { app } = await getTestServer();
    expect((await app.request("/widget/client.js")).status).toBe(200);
    expect((await app.request("/u/js/client.js")).status).toBe(200);
    // /u2/continue exists (400 for a missing state, not 404)
    expect((await app.request("/u2/continue")).status).not.toBe(404);
  });
});
