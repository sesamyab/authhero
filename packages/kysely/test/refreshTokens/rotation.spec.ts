import { describe, expect, it } from "vitest";
import { getTestServer } from "../helpers/test-server";
import {
  AuthorizationResponseType,
  LoginSessionState,
} from "@authhero/adapter-interfaces";

async function seedTenantAndClient(data: any) {
  await data.tenants.create({
    id: "tenantId",
    friendly_name: "Test Tenant",
    audience: "https://example.com",
    sender_email: "login@example.com",
    sender_name: "SenderName",
  });

  await data.clients.create("tenantId", {
    client_id: "clientId",
    client_secret: "clientSecret",
    name: "Test Client",
    callbacks: ["https://example.com/callback"],
    allowed_logout_urls: ["https://example.com/callback"],
    web_origins: ["https://example.com"],
    client_metadata: {},
  });
}

async function createLoginSession(data: any, expiresAt: string) {
  return data.loginSessions.create("tenantId", {
    csrf_token: "csrf",
    authParams: {
      client_id: "clientId",
      response_type: AuthorizationResponseType.CODE,
      scope: "openid offline_access",
    },
    expires_at: expiresAt,
    state: LoginSessionState.PENDING,
  });
}

function device() {
  return {
    last_ip: "",
    initial_ip: "",
    last_user_agent: "",
    initial_user_agent: "",
    initial_asn: "",
    last_asn: "",
  };
}

const baseFields = (login_id: string) => ({
  login_id,
  user_id: "email|userId",
  client_id: "clientId",
  resource_servers: [{ audience: "http://example.com", scopes: "openid" }],
  device: device(),
  rotating: true,
  expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  idle_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
});

describe("refresh tokens — rotation columns", () => {
  it("getByLookup returns the row matching the plaintext lookup slice", async () => {
    const { data } = await getTestServer();
    await seedTenantAndClient(data);
    const ls = await createLoginSession(
      data,
      new Date(Date.now() + 3600_000).toISOString(),
    );

    await data.refreshTokens.create("tenantId", {
      ...baseFields(ls.id),
      id: "rt-with-lookup",
      token_lookup: "abc123",
      token_hash:
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      family_id: "rt-with-lookup",
    });

    const found = await data.refreshTokens.getByLookup("tenantId", "abc123");
    expect(found?.id).toBe("rt-with-lookup");
    expect(found?.token_hash).toBe(
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );

    const missing = await data.refreshTokens.getByLookup(
      "tenantId",
      "doesnotexist",
    );
    expect(missing).toBeNull();
  });

  it("revokeFamily soft-revokes every sibling sharing the family_id", async () => {
    const { data } = await getTestServer();
    await seedTenantAndClient(data);
    const ls = await createLoginSession(
      data,
      new Date(Date.now() + 3600_000).toISOString(),
    );

    await data.refreshTokens.create("tenantId", {
      ...baseFields(ls.id),
      id: "parent",
      family_id: "parent",
    });
    await data.refreshTokens.create("tenantId", {
      ...baseFields(ls.id),
      id: "child-1",
      family_id: "parent",
    });
    await data.refreshTokens.create("tenantId", {
      ...baseFields(ls.id),
      id: "child-2",
      family_id: "parent",
    });
    // unrelated row in a different family — should be untouched.
    await data.refreshTokens.create("tenantId", {
      ...baseFields(ls.id),
      id: "outsider",
      family_id: "outsider",
    });

    const revokedAt = new Date().toISOString();
    const updated = await data.refreshTokens.revokeFamily(
      "tenantId",
      "parent",
      revokedAt,
    );
    expect(updated).toBe(3);

    const parent = await data.refreshTokens.get("tenantId", "parent");
    const child1 = await data.refreshTokens.get("tenantId", "child-1");
    const child2 = await data.refreshTokens.get("tenantId", "child-2");
    const outsider = await data.refreshTokens.get("tenantId", "outsider");
    expect(parent?.revoked_at).toBeTypeOf("string");
    expect(child1?.revoked_at).toBeTypeOf("string");
    expect(child2?.revoked_at).toBeTypeOf("string");
    expect(outsider?.revoked_at).toBeUndefined();
  });

  it("revokeFamily skips already-revoked rows", async () => {
    const { data } = await getTestServer();
    await seedTenantAndClient(data);
    const ls = await createLoginSession(
      data,
      new Date(Date.now() + 3600_000).toISOString(),
    );

    await data.refreshTokens.create("tenantId", {
      ...baseFields(ls.id),
      id: "rt-pre-revoked",
      family_id: "rt-pre-revoked",
    });
    await data.refreshTokens.update("tenantId", "rt-pre-revoked", {
      revoked_at: new Date(Date.now() - 1000).toISOString(),
    });

    await data.refreshTokens.create("tenantId", {
      ...baseFields(ls.id),
      id: "rt-active",
      family_id: "rt-pre-revoked",
    });

    const updated = await data.refreshTokens.revokeFamily(
      "tenantId",
      "rt-pre-revoked",
      new Date().toISOString(),
    );
    expect(updated).toBe(1); // only the active sibling
  });
});
