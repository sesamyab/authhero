import { describe, it, expect } from "vitest";
import { testClient } from "hono/testing";
import { getTestServer } from "../../helpers/test-server";
import { getAdminToken } from "../../helpers/token";
import { hashRegistrationToken } from "../../../src/helpers/dcr/mint-token";
import type { Bindings } from "../../../src/types";

/**
 * Developer app invites and edit links (#1776): presets minted through the
 * Management API, registration with the resulting token on /oidc/register,
 * the developer URL rules, the edit allow-list and invite management.
 */

type MintResponse = {
  id: string;
  token: string;
  expires_at: string;
  ticket?: string;
  source?: string;
  name?: string;
  constraints?: Record<string, unknown>;
};

async function enableDcr(env: Bindings) {
  await env.data.tenants.update("tenantId", {
    flags: {
      enable_dynamic_client_registration: true,
      dcr_require_initial_access_token: true,
    },
  });
}

async function mintInvite(
  managementApp: any,
  env: Bindings,
  body: Record<string, unknown>,
): Promise<{ status: number; body: MintResponse }> {
  const token = await getAdminToken();
  const response = await testClient(managementApp, env)[
    "client-registration-tokens"
  ].$post(
    { json: body, header: { "tenant-id": "tenantId" } },
    { headers: { authorization: `Bearer ${token}` } },
  );
  return { status: response.status, body: await response.json() };
}

async function register(
  oauthApp: any,
  env: Bindings,
  token: string,
  body: Record<string, unknown>,
) {
  return oauthApp.request(
    "/oidc/register",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "tenant-id": "tenantId",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function put(
  oauthApp: any,
  env: Bindings,
  clientId: string,
  token: string,
  body: Record<string, unknown>,
) {
  return oauthApp.request(
    `/oidc/register/${clientId}`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "tenant-id": "tenantId",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    },
    env,
  );
}

async function managementRequest(
  managementApp: any,
  env: Bindings,
  path: string,
  init: { method?: string; body?: unknown } = {},
) {
  const token = await getAdminToken();
  return managementApp.request(
    path,
    {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "tenant-id": "tenantId",
        ...(init.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    },
    env,
  );
}

describe("developer invites: minting", () => {
  it("expands a preset into constraints and returns a setup page URL", async () => {
    const { managementApp, env } = await getTestServer();
    const before = Date.now();
    const { status, body } = await mintInvite(managementApp, env, {
      preset: "native",
      name: "Agency iOS app",
    });
    expect(status).toBe(201);
    expect(body.source).toBe("invite");
    expect(body.name).toBe("Agency iOS app");
    expect(body.constraints).toMatchObject({
      app_type: "native",
      application_type: "native",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      require_pkce: true,
    });
    const url = new URL(body.ticket!);
    expect(url.pathname).toBe("/u2/self-service/app");
    expect(url.searchParams.get("ticket")).toBe(body.token);
    // Default lifetime of an invite: 7 days.
    const ttl = Date.parse(body.expires_at) - before;
    expect(ttl).toBeGreaterThan(7 * 86400_000 - 60_000);
    expect(ttl).toBeLessThanOrEqual(7 * 86400_000 + 60_000);
  });

  it("requires a label and rejects constraints that contradict the preset", async () => {
    const { managementApp, env } = await getTestServer();
    expect(
      (await mintInvite(managementApp, env, { preset: "spa" })).status,
    ).toBe(400);
    expect(
      (
        await mintInvite(managementApp, env, {
          preset: "spa",
          name: "x",
          constraints: { grant_types: ["client_credentials"] },
        })
      ).status,
    ).toBe(400);
  });

  it("rejects unknown connections, and connections without a preset", async () => {
    const { managementApp, env } = await getTestServer();
    expect(
      (
        await mintInvite(managementApp, env, {
          preset: "spa",
          name: "x",
          connections: ["nope"],
        })
      ).status,
    ).toBe(400);
    expect(
      (await mintInvite(managementApp, env, { connections: ["email"] })).status,
    ).toBe(400);
  });
});

describe("developer invites: registration through /oidc/register", () => {
  it("creates a public native client with no secret and links the invite to it", async () => {
    const { managementApp, oauthApp, env } = await getTestServer();
    await enableDcr(env);
    const invite = (
      await mintInvite(managementApp, env, { preset: "native", name: "iOS" })
    ).body;

    const response = await register(oauthApp, env, invite.token, {
      client_name: "Publisher iOS",
      redirect_uris: ["com.example.app:/callback", "http://127.0.0.1:7777/cb"],
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.client_secret).toBeUndefined();
    expect(body.application_type).toBe("native");
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(body.grant_types).toEqual(["authorization_code", "refresh_token"]);

    const client = await env.data.clients.get("tenantId", body.client_id);
    expect(client?.app_type).toBe("native");
    expect(client?.client_secret).toBeFalsy();
    expect(client?.is_first_party).toBe(true);
    expect(client?.registration_metadata?.registration_token_id).toBe(
      invite.id,
    );

    const used = await env.data.clientRegistrationTokens!.get(
      "tenantId",
      invite.id,
    );
    expect(used?.used_at).toBeTruthy();
    expect(used?.client_id).toBe(body.client_id);

    // The registration access token of an invite-created app expires.
    const rat = await env.data.clientRegistrationTokens!.getByHash(
      "tenantId",
      await hashRegistrationToken(body.registration_access_token),
    );
    expect(rat?.source).toBe("registration");
    expect(rat?.expires_at).toBeTruthy();
  });

  it("returns a secret only for regular web apps", async () => {
    const { managementApp, oauthApp, env } = await getTestServer();
    await enableDcr(env);
    const invite = (
      await mintInvite(managementApp, env, {
        preset: "regular_web",
        name: "Web",
      })
    ).body;
    const response = await register(oauthApp, env, invite.token, {
      client_name: "Web app",
      redirect_uris: ["https://app.example.com/callback"],
    });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.client_secret).toBeTruthy();
    expect(body.token_endpoint_auth_method).toBe("client_secret_post");
  });

  it.each([
    ["myapp://callback", /must contain a dot/],
    ["http://app.example.com/cb", /http is only allowed/],
    ["https://*.example.com/cb", /wildcards/],
    ["https://app.example.com/cb#x", /fragments/],
    ["javascript:alert(1)", /Invalid redirect_uri|not allowed/],
  ])("rejects native redirect URI %s", async (uri, message) => {
    const { managementApp, oauthApp, env } = await getTestServer();
    await enableDcr(env);
    const invite = (
      await mintInvite(managementApp, env, { preset: "native", name: "x" })
    ).body;
    const response = await register(oauthApp, env, invite.token, {
      client_name: "x",
      redirect_uris: [uri],
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error_description).toMatch(message);
  });

  it("rejects private-use schemes and paths for browser apps", async () => {
    const { managementApp, oauthApp, env } = await getTestServer();
    await enableDcr(env);
    const invite = (
      await mintInvite(managementApp, env, { preset: "spa", name: "x" })
    ).body;
    expect(
      (
        await register(oauthApp, env, invite.token, {
          client_name: "x",
          redirect_uris: ["com.example.app:/callback"],
        })
      ).status,
    ).toBe(400);
    const originWithPath = await register(oauthApp, env, invite.token, {
      client_name: "x",
      redirect_uris: ["https://app.example.com/cb"],
      web_origins: ["https://app.example.com/path"],
    });
    expect(originWithPath.status).toBe(400);
    expect((await originWithPath.json()).error_description).toMatch(
      /origin without a path/,
    );
  });

  it("refuses requests that contradict the preset", async () => {
    const { managementApp, oauthApp, env } = await getTestServer();
    await enableDcr(env);
    const invite = (
      await mintInvite(managementApp, env, { preset: "spa", name: "x" })
    ).body;
    for (const body of [
      { token_endpoint_auth_method: "client_secret_basic" },
      { grant_types: ["client_credentials"] },
      { application_type: "native" },
    ]) {
      const response = await register(oauthApp, env, invite.token, {
        client_name: "x",
        redirect_uris: ["https://app.example.com/cb"],
        ...body,
      });
      expect(response.status).toBe(400);
    }
  });

  it("pins login methods when the invite names connections, and leaves the fallback otherwise", async () => {
    const { managementApp, oauthApp, env } = await getTestServer();
    await enableDcr(env);

    const pinned = (
      await mintInvite(managementApp, env, {
        preset: "spa",
        name: "x",
        connections: ["email"],
      })
    ).body;
    const a = await (
      await register(oauthApp, env, pinned.token, {
        client_name: "a",
        redirect_uris: ["https://a.example.com/cb"],
      })
    ).json();
    expect(
      (
        await env.data.clientConnections.listByClient("tenantId", a.client_id)
      ).map((c) => c.id),
    ).toEqual(["email"]);

    const all = (
      await mintInvite(managementApp, env, { preset: "spa", name: "y" })
    ).body;
    const b = await (
      await register(oauthApp, env, all.token, {
        client_name: "b",
        redirect_uris: ["https://b.example.com/cb"],
      })
    ).json();
    expect(
      await env.data.clientConnections.listByClient("tenantId", b.client_id),
    ).toEqual([]);
  });

  it("applies the invite's first-party choice", async () => {
    const { managementApp, oauthApp, env } = await getTestServer();
    await enableDcr(env);
    const invite = (
      await mintInvite(managementApp, env, {
        preset: "spa",
        name: "x",
        is_first_party: false,
      })
    ).body;
    const body = await (
      await register(oauthApp, env, invite.token, {
        client_name: "x",
        redirect_uris: ["https://app.example.com/cb"],
      })
    ).json();
    const client = await env.data.clients.get("tenantId", body.client_id);
    expect(client?.is_first_party).toBe(false);
  });

  it("requires PKCE with S256 at /authorize for an invite-created app", async () => {
    const { managementApp, oauthApp, env } = await getTestServer();
    await enableDcr(env);
    const invite = (
      await mintInvite(managementApp, env, { preset: "spa", name: "x" })
    ).body;
    const { client_id } = await (
      await register(oauthApp, env, invite.token, {
        client_name: "x",
        redirect_uris: ["https://app.example.com/cb"],
      })
    ).json();

    const query = new URLSearchParams({
      client_id,
      response_type: "code",
      redirect_uri: "https://app.example.com/cb",
      state: "s",
      scope: "openid",
    });
    const withoutPkce = await oauthApp.request(
      `/authorize?${query}`,
      { headers: { "tenant-id": "tenantId" } },
      env,
    );
    expect(withoutPkce.status).toBe(400);
    expect(await withoutPkce.text()).toMatch(/PKCE/);

    query.set("code_challenge", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    query.set("code_challenge_method", "S256");
    const withPkce = await oauthApp.request(
      `/authorize?${query}`,
      { headers: { "tenant-id": "tenantId" } },
      env,
    );
    expect(withPkce.status).not.toBe(400);
  });
});

describe("edit allow-list (RFC 7592 PUT)", () => {
  async function inviteClient(
    managementApp: any,
    oauthApp: any,
    env: Bindings,
  ) {
    await enableDcr(env);
    const invite = (
      await mintInvite(managementApp, env, { preset: "native", name: "x" })
    ).body;
    return (
      await register(oauthApp, env, invite.token, {
        client_name: "Native",
        redirect_uris: ["com.example.app:/callback"],
      })
    ).json();
  }

  it("lets the developer change URLs and name, nothing else", async () => {
    const { managementApp, oauthApp, env } = await getTestServer();
    const created = await inviteClient(managementApp, oauthApp, env);

    const ok = await put(
      oauthApp,
      env,
      created.client_id,
      created.registration_access_token,
      {
        client_name: "Renamed",
        redirect_uris: ["com.example.app:/callback", "com.example.app:/v2"],
        post_logout_redirect_uris: ["com.example.app:/logout"],
      },
    );
    expect(ok.status).toBe(200);
    const client = await env.data.clients.get("tenantId", created.client_id);
    expect(client?.name).toBe("Renamed");
    expect(client?.callbacks).toEqual([
      "com.example.app:/callback",
      "com.example.app:/v2",
    ]);
    expect(client?.allowed_logout_urls).toEqual(["com.example.app:/logout"]);
    // Omitted constrained fields keep their value (no reset to defaults).
    expect(client?.token_endpoint_auth_method).toBe("none");
    expect(client?.grant_types).toEqual([
      "authorization_code",
      "refresh_token",
    ]);

    for (const body of [
      { grant_types: ["client_credentials"] },
      { token_endpoint_auth_method: "client_secret_basic" },
      { scope: "openid admin" },
    ]) {
      const refused = await put(
        oauthApp,
        env,
        created.client_id,
        created.registration_access_token,
        { client_name: "x", redirect_uris: ["com.example.app:/cb"], ...body },
      );
      expect(refused.status).toBe(400);
    }
  });

  it("refuses DELETE with the developer's token", async () => {
    const { managementApp, oauthApp, env } = await getTestServer();
    const created = await inviteClient(managementApp, oauthApp, env);
    const response = await oauthApp.request(
      `/oidc/register/${created.client_id}`,
      {
        method: "DELETE",
        headers: {
          "tenant-id": "tenantId",
          authorization: `Bearer ${created.registration_access_token}`,
        },
      },
      env,
    );
    expect(response.status).toBe(405);
  });
});

describe("edit links (POST /clients/{id}/registration-ticket)", () => {
  async function editLink(managementApp: any, env: Bindings, clientId: string) {
    const response = await managementRequest(
      managementApp,
      env,
      `/clients/${clientId}/registration-ticket`,
      { method: "POST", body: {} },
    );
    return { status: response.status, body: await response.json() };
  }

  it("opens a hand-made client to its developer, within the allow-list", async () => {
    const { managementApp, oauthApp, env } = await getTestServer();
    await enableDcr(env);
    const { status, body } = await editLink(managementApp, env, "clientId");
    expect(status).toBe(201);
    const ticket = new URL(body.ticket).searchParams.get("ticket")!;

    const read = await oauthApp.request(
      "/oidc/register/clientId",
      {
        headers: { "tenant-id": "tenantId", authorization: `Bearer ${ticket}` },
      },
      env,
    );
    expect(read.status).toBe(200);

    // The existing wildcard callback is kept as it was; new values follow the
    // developer URL rules.
    const ok = await put(oauthApp, env, "clientId", ticket, {
      client_name: "Test Client",
      redirect_uris: [
        "https://example.com/callback",
        "http://localhost:3000/*",
        "https://new.example.com/callback",
      ],
    });
    expect(ok.status).toBe(200);
    const refusedWildcard = await put(oauthApp, env, "clientId", ticket, {
      client_name: "Test Client",
      redirect_uris: ["https://*.example.org/callback"],
    });
    expect(refusedWildcard.status).toBe(400);

    const refusedGrant = await put(oauthApp, env, "clientId", ticket, {
      client_name: "Test Client",
      redirect_uris: ["https://example.com/callback"],
      grant_types: ["client_credentials"],
    });
    expect(refusedGrant.status).toBe(400);

    const del = await oauthApp.request(
      "/oidc/register/clientId",
      {
        method: "DELETE",
        headers: { "tenant-id": "tenantId", authorization: `Bearer ${ticket}` },
      },
      env,
    );
    expect(del.status).toBe(405);
  });

  it("revokes the previous edit link when a new one is generated", async () => {
    const { managementApp, oauthApp, env } = await getTestServer();
    await enableDcr(env);
    const first = (await editLink(managementApp, env, "clientId")).body;
    const second = (await editLink(managementApp, env, "clientId")).body;
    const firstTicket = new URL(first.ticket).searchParams.get("ticket")!;
    const secondTicket = new URL(second.ticket).searchParams.get("ticket")!;

    const firstRead = await oauthApp.request(
      "/oidc/register/clientId",
      {
        headers: {
          "tenant-id": "tenantId",
          authorization: `Bearer ${firstTicket}`,
        },
      },
      env,
    );
    expect(firstRead.status).toBe(401);
    const secondRead = await oauthApp.request(
      "/oidc/register/clientId",
      {
        headers: {
          "tenant-id": "tenantId",
          authorization: `Bearer ${secondTicket}`,
        },
      },
      env,
    );
    expect(secondRead.status).toBe(200);
  });

  it("caps the lifetime at 30 days and 404s an unknown client", async () => {
    const { managementApp, env } = await getTestServer();
    const tooLong = await managementRequest(
      managementApp,
      env,
      "/clients/clientId/registration-ticket",
      { method: "POST", body: { ttl_sec: 30 * 86400 + 1 } },
    );
    expect(tooLong.status).toBe(400);
    expect((await editLink(managementApp, env, "nope")).status).toBe(404);
  });
});

describe("invite management", () => {
  it("lists invites with status, never exposing tokens, and revokes them", async () => {
    const { managementApp, env } = await getTestServer();
    const invite = (
      await mintInvite(managementApp, env, { preset: "spa", name: "List me" })
    ).body;

    const list = await managementRequest(
      managementApp,
      env,
      "/client-registration-tokens?source=invite&include_totals=true",
    );
    expect(list.status).toBe(200);
    const listed = await list.json();
    expect(listed.total).toBe(1);
    expect(listed.client_registration_tokens[0]).toMatchObject({
      id: invite.id,
      name: "List me",
      status: "active",
      source: "invite",
    });
    const raw = JSON.stringify(listed);
    expect(raw).not.toContain(invite.token);
    expect(raw).not.toContain("token_hash");

    const revoke = await managementRequest(
      managementApp,
      env,
      `/client-registration-tokens/${invite.id}/revoke`,
      { method: "POST" },
    );
    expect(revoke.status).toBe(202);
    const after = await (
      await managementRequest(
        managementApp,
        env,
        `/client-registration-tokens/${invite.id}`,
      )
    ).json();
    expect(after.status).toBe("revoked");

    expect(
      (
        await managementRequest(
          managementApp,
          env,
          "/client-registration-tokens/nope",
        )
      ).status,
    ).toBe(404);
  });

  it("revokes a client's registration tokens when the client is deleted", async () => {
    const { managementApp, env } = await getTestServer();
    const link = await (
      await managementRequest(
        managementApp,
        env,
        "/clients/clientId/registration-ticket",
        { method: "POST", body: {} },
      )
    ).json();
    const del = await managementRequest(
      managementApp,
      env,
      "/clients/clientId",
      {
        method: "DELETE",
      },
    );
    expect(del.status).toBe(200);
    const token = await env.data.clientRegistrationTokens!.get(
      "tenantId",
      link.id,
    );
    expect(token?.revoked_at).toBeTruthy();
  });
});

describe("full PUT keeps constrained fields the caller omits", () => {
  it("does not reset a pinned token_endpoint_auth_method", async () => {
    const { managementApp, oauthApp, env } = await getTestServer();
    await enableDcr(env);
    const iat = (
      await mintInvite(managementApp, env, {
        constraints: { token_endpoint_auth_method: "none" },
      })
    ).body;
    const created = await (
      await register(oauthApp, env, iat.token, {
        client_name: "x",
        redirect_uris: ["https://app.example.com/cb"],
      })
    ).json();
    const response = await put(
      oauthApp,
      env,
      created.client_id,
      created.registration_access_token,
      { client_name: "y", redirect_uris: ["https://app.example.com/cb"] },
    );
    expect(response.status).toBe(200);
    const client = await env.data.clients.get("tenantId", created.client_id);
    expect(client?.token_endpoint_auth_method).toBe("none");
  });
});
