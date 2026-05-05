import { describe, it, expect } from "vitest";
import {
  REFRESH_TOKEN_PREFIX,
  formatRefreshToken,
  generateRefreshTokenParts,
  hashRefreshTokenSecret,
  isLegacyRefreshTokenAccepted,
  parseRefreshToken,
  LEGACY_CUTOFF,
} from "../../src/utils/refresh-token-format";

describe("refresh-token-format", () => {
  describe("generateRefreshTokenParts", () => {
    it("returns a fresh (lookup, secret) pair on each call", () => {
      const a = generateRefreshTokenParts();
      const b = generateRefreshTokenParts();
      expect(a.lookup).not.toBe(b.lookup);
      expect(a.secret).not.toBe(b.secret);
      // base64url charset only
      expect(a.lookup).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(a.secret).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe("hashRefreshTokenSecret", () => {
    it("is deterministic for a given input", async () => {
      const h1 = await hashRefreshTokenSecret("abc.def-123");
      const h2 = await hashRefreshTokenSecret("abc.def-123");
      expect(h1).toBe(h2);
      expect(h1).toMatch(/^[0-9a-f]{64}$/);
    });

    it("differs for different inputs", async () => {
      const h1 = await hashRefreshTokenSecret("a");
      const h2 = await hashRefreshTokenSecret("b");
      expect(h1).not.toBe(h2);
    });
  });

  describe("formatRefreshToken / parseRefreshToken", () => {
    it("round-trips a freshly generated pair", () => {
      const { lookup, secret } = generateRefreshTokenParts();
      const wire = formatRefreshToken(lookup, secret);
      expect(wire.startsWith(REFRESH_TOKEN_PREFIX)).toBe(true);
      const parsed = parseRefreshToken(wire);
      expect(parsed.kind).toBe("new");
      if (parsed.kind === "new") {
        expect(parsed.lookup).toBe(lookup);
        expect(parsed.secret).toBe(secret);
      }
    });

    it("treats inputs without the rt_ prefix as legacy", () => {
      const parsed = parseRefreshToken("01HXY3Z9KQ2M4PSOMEULID");
      expect(parsed).toEqual({ kind: "legacy", id: "01HXY3Z9KQ2M4PSOMEULID" });
    });

    it("treats prefixed-but-no-dot inputs as legacy (defensive)", () => {
      const parsed = parseRefreshToken("rt_lookuponly");
      expect(parsed.kind).toBe("legacy");
    });

    it("treats prefixed inputs with empty lookup or secret as legacy", () => {
      expect(parseRefreshToken("rt_.secret").kind).toBe("legacy");
      expect(parseRefreshToken("rt_lookup.").kind).toBe("legacy");
    });

    it("preserves dots in the secret beyond the first separator", () => {
      // The implementation splits on the *first* dot so a secret containing
      // base64url chars only never collides, but if random output ever had a
      // '.', the lookup must end at the first dot.
      const parsed = parseRefreshToken("rt_abc.def.ghi");
      expect(parsed).toEqual({
        kind: "new",
        lookup: "abc",
        secret: "def.ghi",
      });
    });
  });

  describe("isLegacyRefreshTokenAccepted", () => {
    it("returns true before the cutoff", () => {
      const before = new Date(LEGACY_CUTOFF.getTime() - 1000);
      expect(isLegacyRefreshTokenAccepted(before)).toBe(true);
    });

    it("returns false after the cutoff", () => {
      const after = new Date(LEGACY_CUTOFF.getTime() + 1000);
      expect(isLegacyRefreshTokenAccepted(after)).toBe(false);
    });
  });
});
