import { describe, expect, it } from "vitest";
import { transformSettings } from "./edit";

describe("transformSettings", () => {
  it("drops an untouched login-version toggle", () => {
    expect(
      transformSettings({
        flags: { universal_login_version: false, enable_sso: true },
      }),
    ).toEqual({ flags: { enable_sso: true } });
  });

  it.each(["1", "2"])("keeps universal_login_version %s", (version) => {
    expect(
      transformSettings({ flags: { universal_login_version: version } }),
    ).toEqual({ flags: { universal_login_version: version } });
  });
});
