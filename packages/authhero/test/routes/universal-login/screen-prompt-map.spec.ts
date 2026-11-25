import { describe, expect, it } from "vitest";
import { listScreenIds } from "../../../src/routes/universal-login/screens/registry";
import {
  getPartialsTargetForScreen,
  getPromptScreenForScreen,
  listPartialsScreenIds,
} from "../../../src/routes/universal-login/screen-prompt-map";
import { promptPartialPrompts } from "../../../src/helpers/prompt-partials";

// Registry screens that intentionally have no custom-text prompt.
const NO_CUSTOM_TEXT = new Set<string>([]);

describe("screen-prompt-map", () => {
  it("covers every screen in the registry", () => {
    const missing = listScreenIds().filter(
      (id) => !NO_CUSTOM_TEXT.has(id) && !getPromptScreenForScreen(id),
    );
    expect(missing).toEqual([]);
  });

  it("only attaches partials to registered screens", () => {
    const ids = new Set(listScreenIds());
    expect(listPartialsScreenIds().filter((id) => !ids.has(id))).toEqual([]);
  });

  it("stores every partials prompt under an API-accepted prompt name", () => {
    const allowed = new Set<string>(promptPartialPrompts);
    for (const id of listPartialsScreenIds()) {
      const target = getPartialsTargetForScreen(id)!;
      for (const prompt of [target.prompt, ...(target.fallbackPrompts ?? [])]) {
        expect(allowed.has(prompt)).toBe(true);
      }
    }
  });

  it("reads the passwordless code screens from Auth0's login-passwordless prompt", () => {
    expect(getPartialsTargetForScreen("email-otp-challenge")).toMatchObject({
      prompt: "login-passwordless",
      key: "login-passwordless-email-code",
    });
    expect(getPartialsTargetForScreen("sms-otp-challenge")).toMatchObject({
      prompt: "login-passwordless",
      key: "login-passwordless-sms-otp",
    });
  });
});
