import { describe, it, expect } from "vitest";
import {
  buildScopeClaims,
  buildRequestedClaims,
  getStandardClaim,
} from "../../src/helpers/scope-claims";
import type { User } from "@authhero/adapter-interfaces";

const baseUser: User = {
  user_id: "email|123",
  email: "test@example.com",
  email_verified: true,
  name: "Test User",
  given_name: "Test",
  family_name: "User",
  nickname: "Tester",
  phone_number: "+10000000000",
  phone_verified: false,
  provider: "email",
  connection: "email",
  is_social: false,
  tenant_id: "tenantId",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z",
};

describe("scope-claims helper", () => {
  describe("getStandardClaim", () => {
    it("returns the user's email when requested", () => {
      expect(getStandardClaim(baseUser, "email")).toBe("test@example.com");
    });

    it("returns undefined for unknown claim names", () => {
      expect(getStandardClaim(baseUser, "not_a_real_claim")).toBeUndefined();
    });

    it("converts updated_at to a unix timestamp", () => {
      const ts = getStandardClaim(baseUser, "updated_at");
      // 2026-01-02T00:00:00Z → 1767312000
      expect(typeof ts).toBe("number");
      expect(ts).toBe(Math.floor(new Date(baseUser.updated_at!).getTime() / 1000));
    });

    it("returns phone_verified under the OIDC name phone_number_verified", () => {
      expect(getStandardClaim(baseUser, "phone_number_verified")).toBe(false);
    });
  });

  describe("buildScopeClaims", () => {
    it("emits email claims for the email scope", () => {
      const claims = buildScopeClaims(baseUser, ["openid", "email"]);
      expect(claims).toEqual({
        email: "test@example.com",
        email_verified: true,
      });
    });

    it("ignores unknown scopes", () => {
      const claims = buildScopeClaims(baseUser, ["openid", "unrecognized"]);
      expect(claims).toEqual({});
    });
  });

  describe("buildRequestedClaims (OIDC Core 5.5)", () => {
    it("emits requested standard claims regardless of scope", () => {
      const claims = buildRequestedClaims(baseUser, ["name"]);
      expect(claims).toEqual({ name: "Test User" });
    });

    it("skips claim names the user does not have", () => {
      // Switch off the address field — user has no address
      const claims = buildRequestedClaims(baseUser, ["address"]);
      expect(claims).toEqual({});
    });

    it("silently drops unknown claim names", () => {
      const claims = buildRequestedClaims(baseUser, [
        "name",
        "not_a_standard_claim",
      ]);
      expect(claims).toEqual({ name: "Test User" });
    });
  });
});
