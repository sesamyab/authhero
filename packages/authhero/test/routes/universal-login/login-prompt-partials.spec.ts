import { describe, expect, it } from "vitest";
import { getTestServer } from "../../helpers/test-server";
import { withLoginPartials } from "../../../src/routes/universal-login/screens/login-partials";
import type { ScreenContext } from "../../../src/routes/universal-login/screens/types";

const TERMS = '<p><a href="https://example.com/terms">Terms</a></p>';

async function getScreen(
  screen: string,
  partials: Record<string, Record<string, Record<string, string>>>,
) {
  const { u2App, env } = await getTestServer();
  for (const [prompt, value] of Object.entries(partials)) {
    await env.data.promptPartials?.set("tenantId", prompt, value);
  }
  const session = await env.data.loginSessions.create("tenantId", {
    expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    csrf_token: "csrf",
    authParams: {
      client_id: "clientId",
      redirect_uri: "https://example.com/callback",
    },
  });
  const response = await u2App.request(
    `/screen/${screen}?state=${encodeURIComponent(session.id)}`,
    { headers: { "tenant-id": "tenantId" } },
    env,
  );
  return (await response.json()) as {
    screen: { partials?: Record<string, string> };
  };
}

describe("login prompt partials", () => {
  it.each([
    ["identifier", "login-id"],
    ["enter-password", "login-password"],
    ["login", "login"],
  ])(
    "renders the %s screen's partials from the %s prompt",
    async (screen, prompt) => {
      const body = await getScreen(screen, {
        [prompt]: {
          [prompt]: { "secondary-actions-end": TERMS },
          other: { "form-content-end": "must not render" },
        },
      });
      expect(body.screen.partials).toEqual({ "secondary-actions-end": TERMS });
    },
  );

  it("does not render another prompt's partials", async () => {
    const body = await getScreen("identifier", {
      "login-password": { "login-password": { "form-footer-end": TERMS } },
    });
    expect(body.screen.partials).toBeUndefined();
  });

  it("adds the next step's partials when a handler returns it", async () => {
    const { env } = await getTestServer();
    await env.data.promptPartials?.set("tenantId", "login-password", {
      "login-password": { "secondary-actions-end": TERMS },
    });
    const screen = (name: string) => ({
      screen: { name, action: "", method: "POST" as const, components: [] },
    });
    const definition = withLoginPartials({
      id: "identifier",
      name: "Identifier",
      handler: {
        get: async () => screen("identifier"),
        post: async () => ({ screen: screen("enter-password") }),
      },
    });
    const context = {
      ctx: { env },
      tenant: { id: "tenantId" },
    } as unknown as ScreenContext;

    const result = await definition.handler.post!(context, {});

    expect("screen" in result && result.screen.screen.partials).toEqual({
      "secondary-actions-end": TERMS,
    });
  });
});
