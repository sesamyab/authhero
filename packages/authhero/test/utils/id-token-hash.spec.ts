import { describe, it, expect } from "vitest";
import { computeIdTokenHash } from "../../src/utils/id-token-hash";

describe("computeIdTokenHash", () => {
  // The lengths of the left-half base64url-encoded outputs are
  // mathematically determined by the digest size:
  //   SHA-256 →  16 bytes → 22 chars (no padding)
  //   SHA-384 →  24 bytes → 32 chars (no padding)
  //   SHA-512 →  32 bytes → 43 chars (no padding)

  it("uses SHA-256 for RS256 / ES256 / HS256", async () => {
    const rs = await computeIdTokenHash("abc", "RS256");
    const es = await computeIdTokenHash("abc", "ES256");
    const hs = await computeIdTokenHash("abc", "HS256");
    expect(rs.length).toBe(22);
    expect(es).toBe(rs);
    expect(hs).toBe(rs);
  });

  it("uses SHA-384 for RS384", async () => {
    const hash = await computeIdTokenHash("abc", "RS384");
    expect(hash.length).toBe(32);
    expect(hash).not.toBe(await computeIdTokenHash("abc", "RS256"));
  });

  it("uses SHA-512 for ES512", async () => {
    const hash = await computeIdTokenHash("abc", "ES512");
    expect(hash.length).toBe(43);
  });

  it("is deterministic and depends on the input value", async () => {
    const a = await computeIdTokenHash("value-a", "RS256");
    const aAgain = await computeIdTokenHash("value-a", "RS256");
    const b = await computeIdTokenHash("value-b", "RS256");
    expect(a).toBe(aAgain);
    expect(a).not.toBe(b);
  });

  it("emits base64url with no padding", async () => {
    const hash = await computeIdTokenHash(
      "https://example.com/cb?with=padding-prone-input",
      "RS256",
    );
    expect(hash).not.toContain("=");
    expect(hash).not.toContain("+");
    expect(hash).not.toContain("/");
  });

  it("rejects unsupported algs", async () => {
    await expect(computeIdTokenHash("abc", "PS256")).rejects.toThrow(
      /unsupported signing alg/i,
    );
  });
});
