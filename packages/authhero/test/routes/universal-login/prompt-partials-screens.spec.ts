import { describe, expect, it, vi } from "vitest";
import { getTestServer } from "../../helpers/test-server";
import { withPromptPartials } from "../../../src/routes/universal-login/screens/login-partials";
import { screenRegistry } from "../../../src/routes/universal-login/screens/registry";
import {
  getPartialsTargetForScreen,
  listPartialsScreenIds,
} from "../../../src/routes/universal-login/screen-prompt-map";
import type {
  ScreenContext,
  ScreenDefinition,
} from "../../../src/routes/universal-login/screens/types";

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
      username: "foo@example.com",
    },
  });
  const response = await u2App.request(
    `/screen/${screen}?state=${encodeURIComponent(session.id)}`,
    { headers: { "tenant-id": "tenantId" } },
    env,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    screen: { partials?: Record<string, string> };
  };
}

describe("prompt partials on the sign-in form screens", () => {
  it.each([
    ["forgot-password", "reset-password", "reset-password-request"],
    [
      "login-passwordless-identifier",
      "login-passwordless",
      "login-passwordless-identifier",
    ],
    ["email-otp-challenge", "email-otp-challenge", "email-otp-challenge"],
  ])("renders %s partials from %s/%s", async (screen, prompt, key) => {
    const body = await getScreen(screen, {
      [prompt]: {
        [key]: { "form-content-end": TERMS },
        other: { "form-content-end": "must not render" },
      },
    });
    expect(body.screen.partials).toEqual({ "form-content-end": TERMS });
  });

  it.each([
    "forgot-password",
    "login-passwordless-identifier",
    "email-otp-challenge",
  ])("renders %s unchanged when no partials are stored", async (screen) => {
    const body = await getScreen(screen, {});
    expect(body.screen.partials).toBeUndefined();
  });

  it("does not leak partials between screens of the same prompt", async () => {
    const body = await getScreen("forgot-password", {
      "reset-password": {
        "reset-password": { "form-content-end": "other screen" },
      },
    });
    expect(body.screen.partials).toBeUndefined();
  });
});

describe("withPromptPartials", () => {
  const baseScreen = {
    name: "forgot-password",
    action: "/x",
    method: "POST" as const,
    components: [],
  };

  function context(stored: unknown, get = vi.fn().mockResolvedValue(stored)) {
    return {
      ctx: { env: { data: { promptPartials: { get } } } },
      tenant: { id: "t" },
    } as unknown as ScreenContext;
  }

  function definition(screen = baseScreen): ScreenDefinition {
    return {
      id: "x",
      name: "x",
      handler: {
        get: async () => ({ screen }),
        post: async () => ({ error: "boom", screen: { screen } }),
      },
    };
  }

  it.each(listPartialsScreenIds())(
    "wires %s from its own prompt",
    async (id) => {
      const target = getPartialsTargetForScreen(id)!;
      const get = vi.fn().mockResolvedValue({
        [target.key]: { "form-footer-end": TERMS },
      });
      const wrapped = withPromptPartials(
        id,
        definition({ ...baseScreen, name: id }),
      );
      const result = await wrapped.handler.get(context(null, get));
      expect(get).toHaveBeenCalledWith("t", target.prompt);
      expect(result.screen.partials).toEqual({ "form-footer-end": TERMS });
    },
  );

  it("also attaches partials to the screen re-rendered after a failed POST", async () => {
    const wrapped = withPromptPartials("forgot-password", definition());
    const result = await wrapped.handler.post!(
      context({ "reset-password-request": { "form-content-end": TERMS } }),
      {},
    );
    expect(result).toMatchObject({
      error: "boom",
      screen: { screen: { partials: { "form-content-end": TERMS } } },
    });
  });

  it("uses the partials of the screen a POST returns, not the requested one", async () => {
    const codeScreen = { ...baseScreen, name: "reset-password-code" };
    const wrapped = withPromptPartials("forgot-password", {
      id: "forgot-password",
      name: "forgot-password",
      handler: {
        get: async () => ({ screen: baseScreen }),
        post: async () => ({ screen: { screen: codeScreen } }),
      },
    });
    const result = await wrapped.handler.post!(
      context({
        "reset-password-request": { "form-content-end": "request" },
        "reset-password-code": { "form-content-end": "code" },
      }),
      {},
    );
    expect(result).toMatchObject({
      screen: { screen: { partials: { "form-content-end": "code" } } },
    });
  });

  it("attaches partials when a screen without its own returns one that has them", async () => {
    const otpScreen = { ...baseScreen, name: "email-otp-challenge" };
    const get = vi.fn().mockResolvedValue({
      "email-otp-challenge": { "form-content-end": TERMS },
    });
    const wrapped = withPromptPartials("identifier", {
      id: "identifier",
      name: "identifier",
      handler: {
        get: async () => ({ screen: baseScreen }),
        post: async () => ({ screen: { screen: otpScreen } }),
      },
    });
    const result = await wrapped.handler.post!(context(null, get), {});
    expect(get).toHaveBeenCalledWith("t", "email-otp-challenge");
    expect(result).toMatchObject({
      screen: { screen: { partials: { "form-content-end": TERMS } } },
    });
  });

  it("does not load partials for a screen without a partials target", async () => {
    const get = vi.fn();
    const wrapped = withPromptPartials("identifier", {
      id: "identifier",
      name: "identifier",
      handler: {
        get: async () => ({ screen: { ...baseScreen, name: "identifier" } }),
      },
    });
    await wrapped.handler.get(context(null, get));
    expect(get).not.toHaveBeenCalled();
  });

  it("keeps the screen as is without stored partials", async () => {
    const wrapped = withPromptPartials("forgot-password", definition());
    const result = await wrapped.handler.get(context(null));
    expect(result.screen).toBe(baseScreen);
  });

  it("does not override partials a screen set itself", async () => {
    const own = { ...baseScreen, partials: { "form-content-end": "own" } };
    const wrapped = withPromptPartials("forgot-password", definition(own));
    const result = await wrapped.handler.get(
      context({ "reset-password-request": { "form-content-end": TERMS } }),
    );
    expect(result.screen.partials).toEqual({ "form-content-end": "own" });
  });

  it("renders without partials when loading them fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const get = vi.fn().mockRejectedValue(new Error("db down"));
    const wrapped = withPromptPartials("forgot-password", definition());
    const result = await wrapped.handler.get(context(null, get));
    expect(result.screen).toBe(baseScreen);
    error.mockRestore();
  });

  it("registers a wrapper for every partials screen", () => {
    for (const id of listPartialsScreenIds()) {
      expect(screenRegistry.has(id)).toBe(true);
    }
  });
});
