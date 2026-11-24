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
      expect(allowed.has(getPartialsTargetForScreen(id)!.prompt)).toBe(true);
    }
  });

  it("uses the screen's custom-text prompt for its partials", () => {
    for (const id of listPartialsScreenIds()) {
      expect(getPartialsTargetForScreen(id)!.prompt).toBe(
        getPromptScreenForScreen(id),
      );
    }
  });
});
