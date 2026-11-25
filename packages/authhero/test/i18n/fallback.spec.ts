import { describe, expect, it } from "vitest";
import { createTranslation } from "../../src/i18n";
import en from "../../locales/en.json";

describe("createTranslation fallback", () => {
  it("falls back to English for an unsupported locale", () => {
    const { m, locale } = createTranslation(
      "login-password",
      "login-password",
      "xx-YY",
    );
    expect(locale).toBe("en");
    expect(m["wrong-credentials"]()).toBe(
      en["login-password"]["login-password"]["wrong-credentials"],
    );
  });

  it("prefers tenant custom text and keeps the default for other keys", () => {
    const { m } = createTranslation("login-password", "login-password", "sv", {
      "login-password": { "wrong-credentials": "Custom" },
    } as never);
    expect(m["wrong-credentials"]()).toBe("Custom");
    expect(m.unexpectedError()).not.toBe("unexpectedError");
  });
});
