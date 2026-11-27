import { describe, expect, it } from "vitest";
import { transformClient } from "./edit";

describe("transformClient", () => {
  it("drops universal_login_version when set to inherit", () => {
    const out = transformClient({
      client_metadata: { universal_login_version: "", foo: "bar" },
    });
    expect(out.client_metadata).toEqual({ foo: "bar" });
  });

  it("keeps an explicit universal_login_version", () => {
    for (const version of ["1", "2"]) {
      const out = transformClient({
        client_metadata: { universal_login_version: version },
      });
      expect(out.client_metadata).toEqual({ universal_login_version: version });
    }
  });
});
