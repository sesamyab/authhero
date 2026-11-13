import { describe, expect, it, afterAll, afterEach, beforeEach } from "vitest";
import type { RefreshTokenInsert } from "@authhero/adapter-interfaces";
import {
  clearTestData,
  getTestServer,
  teardownTestServer,
} from "./helpers/test-server";

const device = {
  last_ip: "",
  initial_ip: "",
  last_user_agent: "",
  initial_user_agent: "",
  initial_asn: "",
  last_asn: "",
};

const provenance = {
  client_id: "nativeClient",
  family_id: "family-1",
  cascade_revocation: true,
};

const past = () => new Date(Date.now() - 60_000).toISOString();
const future = () => new Date(Date.now() + 60_000).toISOString();

describe("session transfer provenance (#1710)", () => {
  let data: Awaited<ReturnType<typeof getTestServer>>["data"];

  beforeEach(async () => {
    data = (await getTestServer()).data;
    for (const id of ["t1", "t2"]) {
      await data.tenants.create({
        id,
        friendly_name: id,
        audience: "https://example.com",
        sender_email: "login@example.com",
        sender_name: "SenderName",
      });
    }
  });

  afterEach(async () => {
    await clearTestData();
  });

  afterAll(async () => {
    await teardownTestServer();
  });

  const mkToken = (
    tenant_id: string,
    id: string,
    extra: Partial<RefreshTokenInsert> = {},
  ) =>
    data.refreshTokens.create(tenant_id, {
      id,
      login_id: "ls-1",
      user_id: "user-1",
      client_id: "c1",
      device,
      resource_servers: [],
      rotating: true,
      ...extra,
    });

  describe("sessions", () => {
    it("round-trips session_transfer through create, get and list", async () => {
      await data.sessions.create("t1", {
        id: "transferred",
        user_id: "user-1",
        login_session_id: "ls-1",
        device,
        clients: ["webClient"],
        session_transfer: provenance,
      });

      expect(
        (await data.sessions.get("t1", "transferred"))?.session_transfer,
      ).toEqual(provenance);

      const { sessions } = await data.sessions.list("t1");
      expect(
        sessions.find((s) => s.id === "transferred")?.session_transfer,
      ).toEqual(provenance);
    });

    it("leaves session_transfer absent when not provided", async () => {
      await data.sessions.create("t1", {
        id: "plain",
        user_id: "user-1",
        login_session_id: "ls-1",
        device,
        clients: ["webClient"],
      });

      const session = await data.sessions.get("t1", "plain");
      expect(session).not.toHaveProperty("session_transfer");
    });

    it("writes session_transfer on update only when provided", async () => {
      await data.sessions.create("t1", {
        id: "s",
        user_id: "user-1",
        login_session_id: "ls-1",
        device,
        clients: ["webClient"],
        session_transfer: provenance,
      });

      await data.sessions.update("t1", "s", { clients: ["a", "b"] });
      expect((await data.sessions.get("t1", "s"))?.session_transfer).toEqual(
        provenance,
      );

      const updated = { ...provenance, cascade_revocation: false };
      await data.sessions.update("t1", "s", { session_transfer: updated });
      expect((await data.sessions.get("t1", "s"))?.session_transfer).toEqual(
        updated,
      );
    });
  });

  describe("refresh tokens", () => {
    it("round-trips session_transfer through create, get and update", async () => {
      const created = await mkToken("t1", "rt-1", {
        session_transfer: provenance,
      });
      expect(created.session_transfer).toEqual(provenance);
      expect(
        (await data.refreshTokens.get("t1", "rt-1"))?.session_transfer,
      ).toEqual(provenance);

      const updated = { ...provenance, cascade_revocation: false };
      await data.refreshTokens.update("t1", "rt-1", {
        session_transfer: updated,
      });
      expect(
        (await data.refreshTokens.get("t1", "rt-1"))?.session_transfer,
      ).toEqual(updated);
    });

    it("leaves session_transfer absent when not provided", async () => {
      const created = await mkToken("t1", "rt-plain");
      expect(created).not.toHaveProperty("session_transfer");
      expect(await data.refreshTokens.get("t1", "rt-plain")).not.toHaveProperty(
        "session_transfer",
      );
    });
  });

  describe("isFamilyActive", () => {
    it("is true for a live token matched by family_id", async () => {
      await mkToken("t1", "rt-old", { family_id: "fam", rotated_to: "rt-new" });
      await mkToken("t1", "rt-new", {
        family_id: "fam",
        expires_at: future(),
        idle_expires_at: future(),
      });

      expect(await data.refreshTokens.isFamilyActive("t1", "fam")).toBe(true);
    });

    it("is true for a legacy row matched by id with no family_id", async () => {
      await mkToken("t1", "rt-legacy");

      expect(await data.refreshTokens.isFamilyActive("t1", "rt-legacy")).toBe(
        true,
      );
    });

    it("is false when the only un-rotated member is revoked", async () => {
      await mkToken("t1", "rt-old", { family_id: "fam", rotated_to: "rt-new" });
      await mkToken("t1", "rt-new", { family_id: "fam" });
      await data.refreshTokens.update("t1", "rt-new", {
        revoked_at: new Date().toISOString(),
      });

      expect(await data.refreshTokens.isFamilyActive("t1", "fam")).toBe(false);
    });

    it("is false when every member is rotated away, even unrevoked", async () => {
      await mkToken("t1", "rt-a", { family_id: "fam", rotated_to: "rt-b" });
      await mkToken("t1", "rt-b", { family_id: "fam", rotated_to: "rt-c" });

      expect(await data.refreshTokens.isFamilyActive("t1", "fam")).toBe(false);
    });

    it("is false when the live member is expired", async () => {
      await mkToken("t1", "rt-exp", { family_id: "fam", expires_at: past() });

      expect(await data.refreshTokens.isFamilyActive("t1", "fam")).toBe(false);
    });

    it("is false when the live member is idle-expired", async () => {
      await mkToken("t1", "rt-idle", {
        family_id: "fam",
        expires_at: future(),
        idle_expires_at: past(),
      });

      expect(await data.refreshTokens.isFamilyActive("t1", "fam")).toBe(false);
    });

    it("is false for an unknown family", async () => {
      expect(await data.refreshTokens.isFamilyActive("t1", "nope")).toBe(false);
    });

    it("does not cross tenants", async () => {
      await mkToken("t2", "rt-t2", { family_id: "fam" });

      expect(await data.refreshTokens.isFamilyActive("t1", "fam")).toBe(false);
      expect(await data.refreshTokens.isFamilyActive("t1", "rt-t2")).toBe(
        false,
      );
      expect(await data.refreshTokens.isFamilyActive("t2", "fam")).toBe(true);
    });
  });
});
