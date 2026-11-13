import { beforeEach, describe, expect, it } from "vitest";
import {
  AuthorizationResponseType,
  LoginSessionState,
  type DataAdapters,
  type RefreshTokenInsert,
} from "@authhero/adapter-interfaces";
import { getTestServer } from "../helpers/test-server";

const device = {
  last_ip: "",
  initial_ip: "",
  last_user_agent: "",
  initial_user_agent: "",
  initial_asn: "",
  last_asn: "",
};

const provenance = {
  client_id: "senderClient",
  family_id: "family-1",
  cascade_revocation: true,
};

const past = () => new Date(Date.now() - 60_000).toISOString();
const future = () => new Date(Date.now() + 60_000).toISOString();

describe("session transfer provenance (#1710)", () => {
  let data: DataAdapters;
  const loginIds: Record<string, string> = {};

  beforeEach(async () => {
    data = (await getTestServer()).data;

    for (const tenantId of ["t1", "t2"]) {
      await data.tenants.create({
        id: tenantId,
        friendly_name: tenantId,
        audience: "https://example.com",
        sender_email: "login@example.com",
        sender_name: "SenderName",
      });
      await data.clients.create(tenantId, {
        client_id: "clientId",
        client_secret: "clientSecret",
        name: "Test Client",
        callbacks: ["https://example.com/callback"],
        allowed_logout_urls: [],
        web_origins: [],
        client_metadata: {},
      });
      await data.users.create(tenantId, {
        user_id: "email|userId",
        email: "foo@example.com",
        email_verified: true,
        connection: "email",
        provider: "email",
        is_social: false,
      });
      const loginSession = await data.loginSessions.create(tenantId, {
        csrf_token: "csrf",
        authParams: {
          client_id: "clientId",
          response_type: AuthorizationResponseType.CODE,
          scope: "openid offline_access",
        },
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        state: LoginSessionState.PENDING,
      });
      loginIds[tenantId] = loginSession.id;
    }
  });

  const mkToken = (
    tenantId: string,
    id: string,
    extra: Partial<RefreshTokenInsert> = {},
  ) =>
    data.refreshTokens.create(tenantId, {
      id,
      login_id: loginIds[tenantId] ?? "",
      user_id: "email|userId",
      client_id: "clientId",
      device,
      resource_servers: [],
      rotating: true,
      ...extra,
    });

  const mkSession = (id: string, withProvenance: boolean) =>
    data.sessions.create("t1", {
      id,
      user_id: "email|userId",
      login_session_id: loginIds.t1 ?? "",
      device,
      clients: ["clientId"],
      ...(withProvenance ? { session_transfer: provenance } : {}),
    });

  describe("sessions", () => {
    it("round-trips session_transfer through create, get and list", async () => {
      const created = await mkSession("transferred", true);
      expect(created.session_transfer).toEqual(provenance);

      expect(
        (await data.sessions.get("t1", "transferred"))?.session_transfer,
      ).toEqual(provenance);

      const { sessions } = await data.sessions.list("t1");
      expect(
        sessions.find((s) => s.id === "transferred")?.session_transfer,
      ).toEqual(provenance);
    });

    it("leaves session_transfer unset when not provided", async () => {
      await mkSession("plain", false);

      const session = await data.sessions.get("t1", "plain");
      expect(session?.session_transfer).toBeUndefined();
    });

    it("writes session_transfer on update only when provided", async () => {
      await mkSession("s", true);

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

    it("leaves session_transfer unset when not provided", async () => {
      await mkToken("t1", "rt-plain");
      const stored = await data.refreshTokens.get("t1", "rt-plain");
      expect(stored?.session_transfer).toBeUndefined();
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

  describe("codes.consume", () => {
    it("succeeds once and never again", async () => {
      await data.codes.create("t1", {
        code_id: "hash-1",
        code_type: "session_transfer_token",
        login_id: loginIds.t1 ?? "",
        user_id: "email|userId",
        expires_at: future(),
      });

      const results = await Promise.all([
        data.codes.consume("t1", "hash-1"),
        data.codes.consume("t1", "hash-1"),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await data.codes.consume("t1", "hash-1")).toBe(false);

      const stored = await data.codes.get(
        "t1",
        "hash-1",
        "session_transfer_token",
      );
      expect(stored?.used_at).toBeTruthy();
    });

    it("does not consume another tenant's code", async () => {
      await data.codes.create("t2", {
        code_id: "hash-2",
        code_type: "session_transfer_token",
        login_id: loginIds.t2 ?? "",
        user_id: "email|userId",
        expires_at: future(),
      });

      expect(await data.codes.consume("t1", "hash-2")).toBe(false);
      expect(await data.codes.consume("t2", "hash-2")).toBe(true);
    });
  });
});
