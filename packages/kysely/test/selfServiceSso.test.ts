import { describe, it, expect, beforeEach } from "vitest";
import { getTestServer } from "./helpers/test-server";

const TENANT = "tenant1";
const OTHER = "tenant2";

describe("Self-Service SSO storage (#1763)", () => {
  let data: Awaited<ReturnType<typeof getTestServer>>["data"];
  let db: Awaited<ReturnType<typeof getTestServer>>["db"];

  beforeEach(async () => {
    const server = await getTestServer();
    data = server.data;
    db = server.db;
    for (const id of [TENANT, OTHER]) {
      await data.tenants.create({
        id,
        friendly_name: id,
        audience: "https://example.com",
        sender_email: "login@example.com",
        sender_name: "SenderName",
      });
    }
  });

  describe("selfServiceProfiles", () => {
    it("creates, gets, lists, updates and removes with JSON fields", async () => {
      const adapter = data.selfServiceProfiles!;
      const created = await adapter.create(TENANT, {
        name: "Partners",
        description: "For partner agencies",
        allowed_strategies: ["oidc", "samlp"],
        user_attributes: [
          { name: "email", description: "Email", is_optional: false },
        ],
        branding: {
          logo_url: "https://example.com/logo.png",
          colors: { primary: "#112233" },
        },
      });
      expect(created.id).toMatch(/^ssp_[0-9A-Za-z]{22}$/);
      expect(created).toMatchObject({
        name: "Partners",
        description: "For partner agencies",
        allowed_strategies: ["oidc", "samlp"],
        branding: { colors: { primary: "#112233" } },
      });

      expect(await adapter.get(TENANT, created.id)).toEqual(created);
      expect(await adapter.list(TENANT)).toEqual([created]);

      expect(
        await adapter.update(TENANT, created.id, {
          name: "Renamed",
          description: null,
          branding: null,
          user_attributes: null,
        }),
      ).toBe(true);
      const updated = await adapter.get(TENANT, created.id);
      expect(updated?.name).toBe("Renamed");
      expect(updated?.description).toBeUndefined();
      expect(updated?.branding).toBeUndefined();
      expect(updated?.user_attributes).toBeUndefined();
      expect(updated?.allowed_strategies).toEqual(["oidc", "samlp"]);

      expect(await adapter.remove(TENANT, created.id)).toBe(true);
      expect(await adapter.get(TENANT, created.id)).toBeNull();
      expect(await adapter.remove(TENANT, created.id)).toBe(false);
    });

    it.each([
      ['["oidc","not-a-strategy"]', ["oidc"]],
      ['["not-a-strategy"]', []],
      ['["oidc",42,null]', ["oidc"]],
      ['{"oidc":true}', []],
      ["not json", []],
    ])(
      "reads stored allowed_strategies %s fail-closed as %j",
      async (raw, expected) => {
        const adapter = data.selfServiceProfiles!;
        const created = await adapter.create(TENANT, {
          name: "Partners",
          allowed_strategies: ["oidc", "samlp", "waad"],
        });
        await db
          .updateTable("self_service_profiles")
          .set({ allowed_strategies: raw })
          .where("id", "=", created.id)
          .execute();
        const read = await adapter.get(TENANT, created.id);
        expect(read?.allowed_strategies).toEqual(expected);
        expect(
          (await adapter.list(TENANT)).find((p) => p.id === created.id)
            ?.allowed_strategies,
        ).toEqual(expected);
      },
    );

    it("reads a profile without allowed_strategies as unrestricted", async () => {
      const adapter = data.selfServiceProfiles!;
      const created = await adapter.create(TENANT, { name: "Partners" });
      expect(
        (await adapter.get(TENANT, created.id))?.allowed_strategies,
      ).toBeUndefined();
    });

    it("never reads, changes or removes another tenant's profile", async () => {
      const adapter = data.selfServiceProfiles!;
      const created = await adapter.create(TENANT, { name: "Partners" });

      expect(await adapter.get(OTHER, created.id)).toBeNull();
      expect(await adapter.list(OTHER)).toEqual([]);
      expect(await adapter.update(OTHER, created.id, { name: "x" })).toBe(
        false,
      );
      expect(await adapter.remove(OTHER, created.id)).toBe(false);
      expect((await adapter.get(TENANT, created.id))?.name).toBe("Partners");
    });

    it("stores custom text per profile, language and page", async () => {
      const adapter = data.selfServiceProfiles!;
      const profile = await adapter.create(TENANT, { name: "Partners" });

      expect(
        await adapter.getCustomText(TENANT, profile.id, "en", "get-started"),
      ).toEqual({});

      await adapter.setCustomText(TENANT, profile.id, "en", "get-started", {
        introduction: "Welcome",
      });
      await adapter.setCustomText(TENANT, profile.id, "en", "get-started", {
        introduction: "Hello",
      });
      expect(
        await adapter.getCustomText(TENANT, profile.id, "en", "get-started"),
      ).toEqual({ introduction: "Hello" });
      expect(
        await adapter.getCustomText(OTHER, profile.id, "en", "get-started"),
      ).toEqual({});
    });

    it("removes the profile's custom text and tickets with it", async () => {
      const profiles = data.selfServiceProfiles!;
      const tickets = data.ssoAccessTickets!;
      const profile = await profiles.create(TENANT, { name: "Partners" });
      const kept = await profiles.create(TENANT, { name: "Kept" });
      await profiles.setCustomText(TENANT, profile.id, "en", "get-started", {
        introduction: "Welcome",
      });
      const ticket = await tickets.create(TENANT, {
        profile_id: profile.id,
        ticket_hash: "hash-1",
        domain_verification: "required",
        expires_at: "2030-01-01T00:00:00.000Z",
      });
      const keptTicket = await tickets.create(TENANT, {
        profile_id: kept.id,
        ticket_hash: "hash-2",
        domain_verification: "required",
        expires_at: "2030-01-01T00:00:00.000Z",
      });

      await profiles.remove(TENANT, profile.id);

      expect(await tickets.get(TENANT, ticket.id)).toBeNull();
      expect(await tickets.get(TENANT, keptTicket.id)).not.toBeNull();
      // A profile re-created under the same id would not inherit old text.
      expect(
        await profiles.getCustomText(TENANT, profile.id, "en", "get-started"),
      ).toEqual({});
    });
  });

  describe("ssoAccessTickets", () => {
    it("stores a ticket by hash and never returns the hash", async () => {
      const tickets = data.ssoAccessTickets!;
      const created = await tickets.create(TENANT, {
        profile_id: "ssp_1",
        ticket_hash: "abc123",
        connection_config: {
          name: "acme-sso",
          display_name: "Acme",
          options: { domain_aliases: ["acme.com"] },
        },
        enabled_clients: ["client1"],
        enabled_organizations: [
          { organization_id: "org_1", assign_membership_on_login: true },
        ],
        domain_verification: "optional",
        expires_at: "2030-01-01T00:00:00.000Z",
      });

      expect(created.id).toMatch(/^sst_/);
      expect(created).not.toHaveProperty("ticket_hash");
      expect(JSON.stringify(created)).not.toContain("abc123");
      expect(created).toMatchObject({
        profile_id: "ssp_1",
        connection_config: { name: "acme-sso" },
        enabled_clients: ["client1"],
        enabled_organizations: [{ organization_id: "org_1" }],
        domain_verification: "optional",
        expires_at: "2030-01-01T00:00:00.000Z",
      });
      expect(created.connection_id).toBeUndefined();
      expect(created.revoked_at).toBeUndefined();

      expect(await tickets.getByTicketHash(TENANT, "abc123")).toEqual(created);
      expect(await tickets.getByTicketHash(TENANT, "other")).toBeNull();
      // Bound to its tenant.
      expect(await tickets.getByTicketHash(OTHER, "abc123")).toBeNull();
      expect(await tickets.get(OTHER, created.id)).toBeNull();
    });

    it("defaults clients and organizations to empty lists", async () => {
      const created = await data.ssoAccessTickets!.create(TENANT, {
        profile_id: "ssp_1",
        ticket_hash: "h",
        connection_id: "con_1",
        domain_verification: "none",
        expires_at: "2030-01-01T00:00:00.000Z",
      });
      expect(created.enabled_clients).toEqual([]);
      expect(created.enabled_organizations).toEqual([]);
      expect(created.connection_id).toBe("con_1");
    });

    it("rejects a duplicate ticket hash", async () => {
      const tickets = data.ssoAccessTickets!;
      const input = {
        profile_id: "ssp_1",
        ticket_hash: "same",
        domain_verification: "required" as const,
        expires_at: "2030-01-01T00:00:00.000Z",
      };
      await tickets.create(TENANT, input);
      await expect(tickets.create(TENANT, input)).rejects.toThrow();
    });

    it("records connection, revocation and completion", async () => {
      const tickets = data.ssoAccessTickets!;
      const created = await tickets.create(TENANT, {
        profile_id: "ssp_1",
        ticket_hash: "h",
        domain_verification: "required",
        expires_at: "2030-01-01T00:00:00.000Z",
      });

      expect(
        await tickets.update(OTHER, created.id, {
          revoked_at: "2026-01-01T00:00:00.000Z",
        }),
      ).toBe(false);
      expect(
        await tickets.update(TENANT, created.id, {
          connection_id: "con_1",
          completed_at: "2026-01-01T00:00:00.000Z",
          revoked_at: "2026-01-02T00:00:00.000Z",
        }),
      ).toBe(true);
      expect(await tickets.get(TENANT, created.id)).toMatchObject({
        connection_id: "con_1",
        completed_at: "2026-01-01T00:00:00.000Z",
        revoked_at: "2026-01-02T00:00:00.000Z",
      });

      expect(await tickets.remove(OTHER, created.id)).toBe(false);
      expect(await tickets.remove(TENANT, created.id)).toBe(true);
      expect(await tickets.get(TENANT, created.id)).toBeNull();
    });
  });

  describe("connectionDomains", () => {
    it("stores domains lowercased and filters by connection and domain", async () => {
      const domains = data.connectionDomains!;
      const a = await domains.create(TENANT, {
        connection_id: "con_a",
        domain: " Acme.COM ",
        verification_value: "v-a",
      });
      expect(a).toMatchObject({
        connection_id: "con_a",
        domain: "acme.com",
        status: "pending",
        verification_value: "v-a",
      });
      expect(a.verified_at).toBeUndefined();

      // A pending claim on the same domain by another connection is allowed.
      const b = await domains.create(TENANT, {
        connection_id: "con_b",
        domain: "acme.com",
        verification_value: "v-b",
      });
      await domains.create(TENANT, {
        connection_id: "con_b",
        domain: "other.com",
        verification_value: "v-c",
      });

      expect(
        (await domains.list(TENANT, { domain: "ACME.com" }))
          .map((d) => d.id)
          .sort(),
      ).toEqual([a.id, b.id].sort());
      expect(
        (await domains.list(TENANT, { connection_id: "con_b" }))
          .map((d) => d.domain)
          .sort(),
      ).toEqual(["acme.com", "other.com"]);
      expect(await domains.list(OTHER)).toEqual([]);
    });

    it("rejects the same domain twice on one connection", async () => {
      const domains = data.connectionDomains!;
      await domains.create(TENANT, {
        connection_id: "con_a",
        domain: "acme.com",
        verification_value: "v1",
      });
      await expect(
        domains.create(TENANT, {
          connection_id: "con_a",
          domain: "ACME.com",
          verification_value: "v2",
        }),
      ).rejects.toThrow();
    });

    it("verifies, un-verifies and removes within the tenant only", async () => {
      const domains = data.connectionDomains!;
      const created = await domains.create(TENANT, {
        connection_id: "con_a",
        domain: "acme.com",
        verification_value: "v1",
      });

      expect(
        await domains.update(OTHER, created.id, { status: "verified" }),
      ).toBe(false);
      expect(
        await domains.update(TENANT, created.id, {
          status: "verified",
          verified_at: "2026-01-01T00:00:00.000Z",
        }),
      ).toBe(true);
      expect(await domains.get(TENANT, created.id)).toMatchObject({
        status: "verified",
        verified_at: "2026-01-01T00:00:00.000Z",
      });

      await domains.update(TENANT, created.id, {
        status: "pending",
        verified_at: null,
      });
      const pending = await domains.get(TENANT, created.id);
      expect(pending?.status).toBe("pending");
      expect(pending?.verified_at).toBeUndefined();

      expect(await domains.get(OTHER, created.id)).toBeNull();
      expect(await domains.remove(OTHER, created.id)).toBe(false);
      expect(await domains.remove(TENANT, created.id)).toBe(true);
    });
  });

  describe("cleanup and edge cases", () => {
    it("stores a long description unchanged", async () => {
      const description = "d".repeat(1000);
      const created = await data.selfServiceProfiles!.create(TENANT, {
        name: "Partners",
        description,
      });
      expect(
        (await data.selfServiceProfiles!.get(TENANT, created.id))?.description,
      ).toBe(description);
    });

    it("lets concurrent first saves of custom text both succeed", async () => {
      const profiles = data.selfServiceProfiles!;
      const profile = await profiles.create(TENANT, { name: "Partners" });
      await Promise.all([
        profiles.setCustomText(TENANT, profile.id, "en", "get-started", {
          introduction: "one",
        }),
        profiles.setCustomText(TENANT, profile.id, "en", "get-started", {
          introduction: "two",
        }),
      ]);
      expect(
        ["one", "two"].includes(
          (
            await profiles.getCustomText(
              TENANT,
              profile.id,
              "en",
              "get-started",
            )
          ).introduction ?? "",
        ),
      ).toBe(true);
    });

    it("removes a connection's domain claims with the connection only", async () => {
      for (const id of ["con_a", "con_b"]) {
        await data.connections.create(TENANT, {
          id,
          name: id,
          strategy: "oidc",
          options: {},
        });
      }
      const domains = data.connectionDomains!;
      await domains.create(TENANT, {
        connection_id: "con_a",
        domain: "acme.com",
        verification_value: "v-a",
      });
      const kept = await domains.create(TENANT, {
        connection_id: "con_b",
        domain: "acme.com",
        verification_value: "v-b",
      });

      expect(await data.connections.remove(TENANT, "con_a")).toBe(true);

      expect(await domains.list(TENANT, { domain: "acme.com" })).toEqual([
        kept,
      ]);
      expect(await data.connections.remove(TENANT, "con_a")).toBe(false);
    });
  });
});
