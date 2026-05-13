import { describe, it, expect } from "vitest";
import { idTokenSchema } from "../../src/types/IdToken";

describe("idTokenSchema", () => {
  const base = {
    iss: "https://idp.example.com/",
    sub: "user-123",
    exp: 1_700_000_000,
    iat: 1_699_999_000,
  };

  it("accepts aud as a string", () => {
    const parsed = idTokenSchema.parse({ ...base, aud: "client-a" });
    expect(parsed.aud).toBe("client-a");
  });

  // OIDC Core §2 allows `aud` to be an array of strings — providers like
  // JumpCloud emit this when the id_token is intended for multiple audiences.
  it("accepts aud as an array of strings", () => {
    const parsed = idTokenSchema.parse({
      ...base,
      aud: ["client-a", "client-b"],
    });
    expect(parsed.aud).toEqual(["client-a", "client-b"]);
  });

  it("rejects aud values that are neither string nor string[]", () => {
    expect(() => idTokenSchema.parse({ ...base, aud: 42 })).toThrow();
    expect(() => idTokenSchema.parse({ ...base, aud: [1, 2] })).toThrow();
  });
});
