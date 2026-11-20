import { describe, it, expect, vi } from "vitest";
import { getAdminToken } from "../../helpers/token";
import { getTestServer } from "../../helpers/test-server";
import { hashSsoTicketId } from "../../../src/helpers/sso-access-tickets";

const TENANT = "tenantId";
const OTHER = "otherTenant";

type Json = Record<string, unknown>;

function isJson(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function json(response: Response): Promise<Json> {
  const body: unknown = await response.json();
  if (!isJson(body)) throw new Error("expected a JSON object");
  return body;
}

async function jsonArray(response: Response): Promise<Json[]> {
  const body: unknown = await response.json();
  if (!Array.isArray(body)) throw new Error("expected a JSON array");
  return body.filter(isJson);
}

function str(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected a string");
  return value;
}

// Mounted at runtime only when the adapters exist, so it is absent from the
// typed hono client. Use raw requests.
async function setup() {
  const { managementApp, env } = await getTestServer();
  await env.data.tenants.create({
    id: OTHER,
    friendly_name: "Other",
    audience: "https://example.com",
    sender_email: "login@example.com",
    sender_name: "SenderName",
  });
  const adminToken = await getAdminToken();

  const request = (
    path: string,
    init: {
      method?: string;
      body?: unknown;
      tenant?: string;
      token?: string;
    } = {},
  ) =>
    managementApp.request(
      `/self-service-profiles${path}`,
      {
        method: init.method ?? "GET",
        headers: {
          "tenant-id": init.tenant ?? TENANT,
          authorization: `Bearer ${init.token ?? adminToken}`,
          ...(init.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      },
      env,
    );

  const createProfile = async (body: Json = {}, tenant = TENANT) => {
    const response = await request("", {
      method: "POST",
      body: { name: "Partners", ...body },
      tenant,
    });
    expect(response.status).toBe(201);
    return json(response);
  };

  const createTicket = async (
    profileId: string,
    body: Json,
    tenant = TENANT,
  ) => {
    const response = await request(`/${profileId}/sso-ticket`, {
      method: "POST",
      body,
      tenant,
    });
    expect(response.status).toBe(201);
    const ticketUrl = new URL(str((await json(response)).ticket));
    const ticketId = ticketUrl.searchParams.get("ticket");
    if (!ticketId) throw new Error("ticket URL without a ticket");
    const stored = await env.data.ssoAccessTickets!.getByTicketHash(
      tenant,
      await hashSsoTicketId(ticketId),
    );
    return { ticketUrl, ticketId, stored };
  };

  return { env, request, createProfile, createTicket };
}

const fullProfile = {
  name: "Partners",
  description: "For partner agencies",
  allowed_strategies: ["oidc", "samlp", "waad"],
  user_attributes: [
    { name: "email", description: "Email address", is_optional: false },
    { name: "given_name", description: "First name", is_optional: true },
  ],
  branding: {
    logo_url: "https://example.com/logo.png",
    colors: { primary: "#0059d6" },
  },
};

describe("management-api self-service-profiles", () => {
  describe("profiles", () => {
    it("creates, reads, lists, updates and deletes with Auth0 shapes", async () => {
      const { request } = await setup();

      const created = await request("", { method: "POST", body: fullProfile });
      expect(created.status).toBe(201);
      const profile = await json(created);
      expect(Object.keys(profile).sort()).toEqual(
        [
          "allowed_strategies",
          "branding",
          "created_at",
          "description",
          "id",
          "name",
          "updated_at",
          "user_attributes",
        ].sort(),
      );
      expect(profile).toMatchObject(fullProfile);
      expect(str(profile.id)).toMatch(/^ssp_/);

      const id = str(profile.id);
      const got = await request(`/${id}`);
      expect(got.status).toBe(200);
      expect(await json(got)).toEqual(profile);

      const list = await request("");
      expect(list.status).toBe(200);
      expect(await jsonArray(list)).toEqual([profile]);

      const patched = await request(`/${id}`, {
        method: "PATCH",
        body: { name: "Agencies", description: null, branding: null },
      });
      expect(patched.status).toBe(200);
      const updated = await json(patched);
      expect(updated.name).toBe("Agencies");
      expect(updated).not.toHaveProperty("description");
      expect(updated).not.toHaveProperty("branding");
      expect(updated.allowed_strategies).toEqual(["oidc", "samlp", "waad"]);

      const deleted = await request(`/${id}`, { method: "DELETE" });
      expect(deleted.status).toBe(204);
      expect(await deleted.text()).toBe("");

      const missing = await request(`/${id}`);
      expect(missing.status).toBe(404);
      expect(await json(missing)).toEqual({
        statusCode: 404,
        error: "Not Found",
        message: "Self-service profile not found.",
        errorCode: "inexistent_self_service_profile",
      });
      expect((await request(`/${id}`, { method: "DELETE" })).status).toBe(404);
      expect(
        (await request(`/${id}`, { method: "PATCH", body: { name: "x" } }))
          .status,
      ).toBe(404);
    });

    it("pages and returns totals in Auth0's shape", async () => {
      const { request, createProfile } = await setup();
      for (const name of ["a", "b", "c"]) await createProfile({ name });

      const page = await request("?page=1&per_page=2&include_totals=true");
      expect(page.status).toBe(200);
      const body = await json(page);
      expect(Object.keys(body).sort()).toEqual([
        "limit",
        "self_service_profiles",
        "start",
        "total",
      ]);
      expect(body).toMatchObject({ start: 2, limit: 2, total: 3 });
      expect(body.self_service_profiles).toHaveLength(1);

      expect(await jsonArray(await request("?per_page=2"))).toHaveLength(2);
      expect((await request("?per_page=101")).status).toBe(400);
    });

    it("rejects a 21st profile with Auth0's 409", async () => {
      const { request, createProfile } = await setup();
      for (let i = 0; i < 20; i++) await createProfile({ name: `p${i}` });

      const response = await request("", {
        method: "POST",
        body: { name: "one too many" },
      });
      expect(response.status).toBe(409);
      expect(await json(response)).toMatchObject({
        statusCode: 409,
        error: "Conflict",
        message: "No more profiles can be created for this tenant.",
      });
    });

    it.each([
      [{}, "Missing required property: name"],
      [{ name: "" }, "name"],
      [{ name: "x".repeat(101) }, "name"],
      [{ name: "p", description: "x".repeat(141) }, "description"],
      [{ name: "p", unknown_field: true }, "unknown_field"],
      [{ name: "p", allowed_strategies: [] }, "allowed_strategies"],
      [
        { name: "p", allowed_strategies: ["oidc", "okta"] },
        "allowed_strategies.1",
      ],
      [
        { name: "p", allowed_strategies: ["google-apps"] },
        "allowed_strategies.0",
      ],
      [{ name: "p", allowed_strategies: ["facebook"] }, "allowed_strategies"],
      [
        { name: "p", user_attribute_profile_id: "uap_1" },
        "user_attribute_profile_id",
      ],
      [
        { name: "p", user_attributes: [{ name: "email", description: "E" }] },
        "is_optional",
      ],
      [
        {
          name: "p",
          user_attributes: [
            { name: "email", description: "E", is_optional: true, extra: 1 },
          ],
        },
        "extra",
      ],
      [
        { name: "p", branding: { logo_url: "http://example.com/a.png" } },
        "branding.logo_url",
      ],
      [
        { name: "p", branding: { colors: { primary: "blue" } } },
        "branding.colors.primary",
      ],
      [{ name: "p", branding: { font: "Inter" } }, "font"],
    ])(
      "rejects %j with a 400 naming %s, storing nothing",
      async (body, field) => {
        const { request } = await setup();
        const response = await request("", { method: "POST", body });
        expect(response.status).toBe(400);
        const error = await json(response);
        expect(error).toMatchObject({
          statusCode: 400,
          error: "Bad Request",
          errorCode: "invalid_body",
        });
        expect(str(error.message)).toContain(field);
        expect(await jsonArray(await request(""))).toEqual([]);
      },
    );

    it("rejects unsupported fields and strategies on PATCH without changing the profile", async () => {
      const { request, createProfile } = await setup();
      const profile = await createProfile(fullProfile);
      const id = str(profile.id);

      for (const body of [
        { allowed_strategies: ["okta"] },
        { user_attribute_profile_id: "uap_1" },
        { name: "x", unknown_field: 1 },
      ]) {
        const response = await request(`/${id}`, { method: "PATCH", body });
        expect(response.status).toBe(400);
      }
      expect(await json(await request(`/${id}`))).toEqual(profile);
    });

    it("requires the Auth0 scope for each endpoint", async () => {
      const { request, createProfile } = await setup();
      const profile = await createProfile();
      const id = str(profile.id);
      const token = await getAdminToken({ permissions: ["read:clients"] });

      const cases: Array<[string, string, string, unknown?]> = [
        ["GET", "", "read:self_service_profiles"],
        ["POST", "", "create:self_service_profiles", { name: "p" }],
        ["GET", `/${id}`, "read:self_service_profiles"],
        ["PATCH", `/${id}`, "update:self_service_profiles", { name: "p" }],
        ["DELETE", `/${id}`, "delete:self_service_profiles"],
        [
          "GET",
          `/${id}/custom-text/en/get-started`,
          "read:self_service_profile_custom_texts",
        ],
        [
          "PUT",
          `/${id}/custom-text/en/get-started`,
          "update:self_service_profile_custom_texts",
          {},
        ],
        [
          "POST",
          `/${id}/sso-ticket`,
          "create:sso_access_tickets",
          { connection_config: { name: "acme" } },
        ],
        ["POST", `/${id}/sso-ticket/abc/revoke`, "delete:sso_access_tickets"],
      ];
      for (const [method, path, scope, body] of cases) {
        const response = await request(path, { method, body, token });
        expect(response.status, `${method} ${path}`).toBe(403);
        expect(str((await json(response)).message)).toContain(scope);
      }
    });
  });

  describe("custom text", () => {
    it("reads and replaces custom text per language and page", async () => {
      const { request, createProfile } = await setup();
      const id = str((await createProfile()).id);
      const path = `/${id}/custom-text/en/get-started`;

      const empty = await request(path);
      expect(empty.status).toBe(200);
      expect(await json(empty)).toEqual({});

      const put = await request(path, {
        method: "PUT",
        body: { introduction: "Welcome, <b>partner</b>" },
      });
      expect(put.status).toBe(200);
      expect(await json(put)).toEqual({
        introduction: "Welcome, <b>partner</b>",
      });

      await request(path, { method: "PUT", body: { title: "Hi" } });
      expect(await json(await request(path))).toEqual({ title: "Hi" });
    });

    it("rejects unknown languages, pages, long values and missing profiles", async () => {
      const { request, createProfile } = await setup();
      const id = str((await createProfile()).id);

      expect((await request(`/${id}/custom-text/de/get-started`)).status).toBe(
        400,
      );
      expect((await request(`/${id}/custom-text/en/configure`)).status).toBe(
        400,
      );
      expect(
        (
          await request(`/${id}/custom-text/en/get-started`, {
            method: "PUT",
            body: { introduction: "x".repeat(2001) },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await request(`/${id}/custom-text/en/get-started`, {
            method: "PUT",
            body: { introduction: 1 },
          })
        ).status,
      ).toBe(400);

      const missing = await request(`/ssp_missing/custom-text/en/get-started`);
      expect(missing.status).toBe(404);
      expect(
        (
          await request(`/ssp_missing/custom-text/en/get-started`, {
            method: "PUT",
            body: { introduction: "x" },
          })
        ).status,
      ).toBe(404);
    });
  });

  describe("sso tickets", () => {
    it("returns only a ticket URL on the tenant's domain and stores the ticket hashed", async () => {
      const { env, request, createProfile, createTicket } = await setup();
      const org = await env.data.organizations.create(TENANT, {
        name: "acme-org",
      });
      const id = str((await createProfile(fullProfile)).id);

      const response = await request(`/${id}/sso-ticket`, {
        method: "POST",
        body: {
          connection_config: {
            name: "acme-sso",
            display_name: "Acme",
            metadata: { team: "it", dropped: null },
            options: {
              icon_url: "https://acme.com/icon.png",
              domain_aliases: ["acme.com"],
            },
          },
          enabled_clients: ["clientId"],
          enabled_organizations: [
            { organization_id: org.id, assign_membership_on_login: true },
          ],
        },
      });
      expect(response.status).toBe(201);
      const body = await json(response);
      expect(Object.keys(body)).toEqual(["ticket"]);

      const url = new URL(str(body.ticket));
      expect(url.origin).toBe(new URL(env.ISSUER).origin);
      expect(url.pathname).toBe("/u2/self-service");
      const ticketId = url.searchParams.get("ticket");
      expect(ticketId).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const tickets = env.data.ssoAccessTickets!;
      const stored = await tickets.getByTicketHash(
        TENANT,
        await hashSsoTicketId(ticketId ?? ""),
      );
      expect(stored).toMatchObject({
        profile_id: id,
        connection_config: {
          name: "acme-sso",
          display_name: "Acme",
          metadata: { team: "it" },
          options: {
            icon_url: "https://acme.com/icon.png",
            domain_aliases: ["acme.com"],
          },
        },
        enabled_clients: ["clientId"],
        enabled_organizations: [
          { organization_id: org.id, assign_membership_on_login: true },
        ],
        // Not specified: Required by default.
        domain_verification: "required",
      });
      expect(stored?.connection_id).toBeUndefined();
      // The clear ticket id is never stored or used as an id.
      expect(JSON.stringify(stored)).not.toContain(ticketId);
      expect(await tickets.getByTicketHash(TENANT, ticketId ?? "")).toBeNull();

      // Default lifetime: 5 days.
      const ttl = Date.parse(stored?.expires_at ?? "") - Date.now();
      expect(ttl).toBeGreaterThan(432000 * 1000 - 60_000);
      expect(ttl).toBeLessThanOrEqual(432000 * 1000);
    });

    it("issues an edit ticket for an existing connection with an allowed strategy", async () => {
      const { env, createProfile, createTicket } = await setup();
      const connection = await env.data.connections.create(TENANT, {
        name: "acme-oidc",
        strategy: "oidc",
        options: {},
      });
      const id = str(
        (await createProfile({ allowed_strategies: ["oidc"] })).id,
      );

      const { stored } = await createTicket(id, {
        connection_id: connection.id,
        domain_aliases_config: { domain_verification: "optional" },
      });
      expect(stored).toMatchObject({
        connection_id: connection.id,
        domain_verification: "optional",
      });
      expect(stored?.connection_config).toBeUndefined();
    });

    it("applies the ttl_sec limits", async () => {
      const { request, createProfile, createTicket } = await setup();
      const id = str((await createProfile()).id);

      const max = await createTicket(id, {
        connection_config: { name: "max-ttl" },
        ttl_sec: 2592000,
      });
      const maxTtl = Date.parse(max.stored?.expires_at ?? "") - Date.now();
      expect(maxTtl).toBeGreaterThan(2592000 * 1000 - 60_000);

      const zero = await createTicket(id, {
        connection_config: { name: "zero-ttl" },
        ttl_sec: 0,
      });
      const zeroTtl = Date.parse(zero.stored?.expires_at ?? "") - Date.now();
      expect(zeroTtl).toBeGreaterThan(432000 * 1000 - 60_000);
      expect(zeroTtl).toBeLessThanOrEqual(432000 * 1000);

      const short = await createTicket(id, {
        connection_config: { name: "short-ttl" },
        ttl_sec: 60,
      });
      expect(
        Date.parse(short.stored?.expires_at ?? "") - Date.now(),
      ).toBeLessThanOrEqual(60 * 1000);

      for (const ttl_sec of [2592001, -1, 1.5, "60"]) {
        const response = await request(`/${id}/sso-ticket`, {
          method: "POST",
          body: { connection_config: { name: "bad-ttl" }, ttl_sec },
        });
        expect(response.status, String(ttl_sec)).toBe(400);
        expect(str((await json(response)).message)).toContain("ttl_sec");
      }
    });

    it.each([
      [
        { provisioning_config: { scopes: ["get:users"] } },
        "provisioning_config",
      ],
      [
        { use_for_organization_discovery: true },
        "use_for_organization_discovery",
      ],
      [
        { use_for_organization_discovery: false },
        "use_for_organization_discovery",
      ],
      [{ enabled_features: { sso: true } }, "enabled_features"],
      [
        { third_party_client_access_config: { allow_configuration: true } },
        "third_party_client_access_config",
      ],
      [
        { universal_logout_config: { allow_configuration: true } },
        "universal_logout_config",
      ],
      [{ not_an_auth0_field: 1 }, "not_an_auth0_field"],
      [
        {
          domain_aliases_config: {
            domain_verification: "required",
            pending_domains: ["acme.com"],
          },
        },
        "domain_aliases_config.pending_domains",
      ],
      [
        { domain_aliases_config: { domain_verification: "sometimes" } },
        "domain_aliases_config.domain_verification",
      ],
      [{ domain_aliases_config: {} }, "domain_verification"],
      [
        {
          connection_config: {
            name: "acme",
            options: { idpinitiated: { enabled: true } },
          },
        },
        "connection_config.options.idpinitiated",
      ],
      [{ connection_config: { name: "acme", strategy: "oidc" } }, "strategy"],
      [
        { connection_config: { name: "acme", options: { client_id: "x" } } },
        "client_id",
      ],
      [{ connection_config: { name: "not valid!" } }, "connection_config.name"],
      [
        {
          connection_config: {
            name: "acme",
            options: { icon_url: "http://x" },
          },
        },
        "connection_config.options.icon_url",
      ],
      [
        {
          connection_config: {
            name: "acme",
            metadata: Object.fromEntries(
              Array.from({ length: 11 }, (_, i) => [`k${i}`, "v"]),
            ),
          },
        },
        "connection_config.metadata",
      ],
      [
        { enabled_organizations: [{ organization_id: "org_1", role: "x" }] },
        "role",
      ],
    ])(
      "rejects %j with a 400 naming %s and stores no ticket",
      async (extra, field) => {
        const { env, request, createProfile } = await setup();
        const id = str((await createProfile()).id);
        const create = vi.spyOn(env.data.ssoAccessTickets!, "create");

        const response = await request(`/${id}/sso-ticket`, {
          method: "POST",
          body: { connection_config: { name: "acme" }, ...extra },
        });
        expect(response.status).toBe(400);
        const error = await json(response);
        expect(error).toMatchObject({
          statusCode: 400,
          error: "Bad Request",
          errorCode: "invalid_body",
        });
        expect(str(error.message)).toContain(field);
        expect(create).not.toHaveBeenCalled();
      },
    );

    it("validates the ticket against the tenant and the profile", async () => {
      const { env, request, createProfile } = await setup();
      const oidc = await env.data.connections.create(TENANT, {
        name: "acme-oidc",
        strategy: "oidc",
        options: {},
      });
      const okta = await env.data.connections.create(TENANT, {
        name: "acme-okta",
        strategy: "okta",
        options: {},
      });
      const otherTenantConnection = await env.data.connections.create(OTHER, {
        name: "other-oidc",
        strategy: "oidc",
        options: {},
      });
      const otherOrg = await env.data.organizations.create(OTHER, {
        name: "other-org",
      });
      const samlOnly = str(
        (await createProfile({ allowed_strategies: ["samlp"] })).id,
      );
      const id = str((await createProfile()).id);
      const create = vi.spyOn(env.data.ssoAccessTickets!, "create");

      const cases: Array<[string, Json, number, string]> = [
        [id, {}, 400, "connection_id or connection_config"],
        [
          id,
          { connection_id: oidc.id, connection_config: { name: "x" } },
          400,
          "connection_id",
        ],
        [id, { connection_id: "con_missing" }, 400, "connection_id"],
        // A connection of another tenant does not exist here.
        [id, { connection_id: otherTenantConnection.id }, 400, "connection_id"],
        // Strategy AuthHero does not support for self-service yet.
        [id, { connection_id: okta.id }, 400, "okta"],
        // Built-in database/email connections are not enterprise connections.
        [id, { connection_id: "email" }, 400, "connection_id"],
        // Strategy the profile does not allow.
        [samlOnly, { connection_id: oidc.id }, 400, "oidc"],
        [
          id,
          { connection_config: { name: "x" }, enabled_clients: ["missing"] },
          400,
          "enabled_clients.0",
        ],
        [
          id,
          {
            connection_config: { name: "x" },
            enabled_organizations: [{ organization_id: otherOrg.id }],
          },
          400,
          "enabled_organizations.0.organization_id",
        ],
        [
          id,
          { connection_config: { name: "acme-oidc" } },
          409,
          "already exists",
        ],
        ["ssp_missing", { connection_config: { name: "x" } }, 404, "not found"],
      ];
      for (const [profileId, body, status, text] of cases) {
        const response = await request(`/${profileId}/sso-ticket`, {
          method: "POST",
          body,
        });
        expect(response.status, JSON.stringify(body)).toBe(status);
        expect(str((await json(response)).message)).toContain(text);
      }
      expect(create).not.toHaveBeenCalled();
    });

    it("revokes a ticket by the id in its URL, returning 202 like Auth0", async () => {
      const { env, request, createProfile, createTicket } = await setup();
      const profileId = str((await createProfile()).id);
      const otherProfileId = str((await createProfile({ name: "Other" })).id);
      const { ticketId, stored } = await createTicket(profileId, {
        connection_config: { name: "acme" },
      });
      const tickets = env.data.ssoAccessTickets!;

      // Unknown ticket id: accepted, nothing happens (Auth0 returns 202).
      const unknown = await request(`/${profileId}/sso-ticket/unknown/revoke`, {
        method: "POST",
      });
      expect(unknown.status).toBe(202);
      expect(await unknown.text()).toBe("");

      // Through another profile, or the internal row id: not revoked.
      for (const path of [
        `/${otherProfileId}/sso-ticket/${ticketId}/revoke`,
        `/${profileId}/sso-ticket/${stored?.id}/revoke`,
      ]) {
        expect((await request(path, { method: "POST" })).status).toBe(202);
      }
      expect((await tickets.get(TENANT, stored?.id ?? ""))?.revoked_at).toBe(
        undefined,
      );

      const revoked = await request(
        `/${profileId}/sso-ticket/${ticketId}/revoke`,
        { method: "POST" },
      );
      expect(revoked.status).toBe(202);
      const after = await tickets.get(TENANT, stored?.id ?? "");
      expect(after?.revoked_at).toBeDefined();

      // Revoking again keeps the first revocation time.
      await request(`/${profileId}/sso-ticket/${ticketId}/revoke`, {
        method: "POST",
      });
      expect((await tickets.get(TENANT, stored?.id ?? ""))?.revoked_at).toBe(
        after?.revoked_at,
      );
    });

    it("removes a profile's tickets with the profile", async () => {
      const { env, request, createProfile, createTicket } = await setup();
      const profileId = str((await createProfile()).id);
      const { stored } = await createTicket(profileId, {
        connection_config: { name: "acme" },
      });
      await request(`/${profileId}`, { method: "DELETE" });
      expect(
        await env.data.ssoAccessTickets!.get(TENANT, stored?.id ?? ""),
      ).toBeNull();
    });
  });

  describe("tenant isolation", () => {
    it("never shows or uses a profile or ticket of another tenant", async () => {
      const { env, request, createProfile, createTicket } = await setup();
      const profile = await createProfile(fullProfile);
      const id = str(profile.id);
      await request(`/${id}/custom-text/en/get-started`, {
        method: "PUT",
        body: { introduction: "Tenant A" },
      });
      const { ticketId, stored } = await createTicket(id, {
        connection_config: { name: "acme" },
      });
      const asOther = { tenant: OTHER };

      expect(await jsonArray(await request("", asOther))).toEqual([]);
      expect((await request(`/${id}`, asOther)).status).toBe(404);
      expect(
        (
          await request(`/${id}`, {
            ...asOther,
            method: "PATCH",
            body: { name: "x" },
          })
        ).status,
      ).toBe(404);
      expect(
        (await request(`/${id}/custom-text/en/get-started`, asOther)).status,
      ).toBe(404);
      expect(
        (
          await request(`/${id}/custom-text/en/get-started`, {
            ...asOther,
            method: "PUT",
            body: { introduction: "Tenant B" },
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await request(`/${id}/sso-ticket`, {
            ...asOther,
            method: "POST",
            body: { connection_config: { name: "b" } },
          })
        ).status,
      ).toBe(404);

      // Revoking tenant A's ticket from tenant B does nothing.
      expect(
        (
          await request(`/${id}/sso-ticket/${ticketId}/revoke`, {
            ...asOther,
            method: "POST",
          })
        ).status,
      ).toBe(202);
      const tickets = env.data.ssoAccessTickets!;
      expect((await tickets.get(TENANT, stored?.id ?? ""))?.revoked_at).toBe(
        undefined,
      );
      expect(
        await tickets.getByTicketHash(OTHER, await hashSsoTicketId(ticketId)),
      ).toBeNull();

      expect(
        (await request(`/${id}`, { ...asOther, method: "DELETE" })).status,
      ).toBe(404);
      expect(await json(await request(`/${id}`))).toEqual(profile);
      expect(
        await json(await request(`/${id}/custom-text/en/get-started`)),
      ).toEqual({ introduction: "Tenant A" });
    });
  });
});
