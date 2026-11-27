import { describe, expect, it } from "vitest";
import { resolveLoginRoutePrefix } from "../../src/helpers/login-version";

describe("resolveLoginRoutePrefix", () => {
  it.each([
    [undefined, undefined, "/u"],
    [undefined, "1", "/u"],
    [undefined, "2", "/u2"],
    ["2", undefined, "/u2"],
    ["2", "1", "/u2"],
    ["1", "2", "/u"],
    ["3", "2", "/u2"],
    ["3", undefined, "/u"],
  ] as const)(
    "client override %s with tenant flag %s → %s",
    (clientVersion, tenantVersion, expected) => {
      expect(
        resolveLoginRoutePrefix({
          client_metadata: clientVersion
            ? { universal_login_version: clientVersion }
            : {},
          tenant: {
            flags: tenantVersion
              ? { universal_login_version: tenantVersion }
              : {},
          },
        }),
      ).toBe(expected);
    },
  );
});
