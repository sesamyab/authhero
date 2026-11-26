import { describe, expect, it } from "vitest";
import { PRE_SCREEN_SCREENS } from "@authhero/adapter-interfaces";
import {
  describePreScreenBinding,
  isPreScreenTrigger,
  PRE_SCREEN_CHOICES,
} from "./pre-screen-binding";

describe("pre-screen bindings", () => {
  it("offers every pre-screen screen", () => {
    expect(PRE_SCREEN_CHOICES.map((c) => c.id)).toEqual(
      PRE_SCREEN_SCREENS.map((s) => s.name),
    );
  });

  it("only applies to the pre-screen trigger", () => {
    expect(isPreScreenTrigger("pre-screen")).toBe(true);
    expect(isPreScreenTrigger("post-user-login")).toBe(false);
  });

  it("describes a binding's screens and failure mode", () => {
    expect(describePreScreenBinding(undefined)).toBe("All screens");
    expect(describePreScreenBinding({ screens: [] })).toBe("All screens");
    expect(
      describePreScreenBinding({
        screens: ["login-id", "nope"],
        fail_closed: true,
      }),
    ).toBe("login-id, nope (unknown); fails closed on render");
  });
});
