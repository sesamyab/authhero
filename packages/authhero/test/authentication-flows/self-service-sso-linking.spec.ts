import { describe, it, expect } from "vitest";
import { Context } from "hono";
import { testClient } from "hono/testing";
import {
  AuthorizationResponseType,
  ConnectionSelfService,
} from "@authhero/adapter-interfaces";
import { getTestServer } from "../helpers/test-server";
import { getAdminToken } from "../helpers/token";
import { addDataHooks } from "../../src/hooks";
import { resolveLinkCandidates } from "../../src/helpers/link-candidates";
import {
  isEmailDomainVerified,
  isUntrustedSelfServiceEmail,
} from "../../src/helpers/self-service-connections";
import { exportTenant } from "../../src/helpers/tenant-export-import";
import { Bindings, Variables } from "../../src/types";

/**
 * Self-Service SSO (#1763): whoever configures a self-service connection's
 * identity provider controls what it asserts. These tests pin the guard that
 * keeps such a connection from taking over accounts through email linking:
 * outside the connection's verified domains its `email_verified` is never
 * trusted, and its users are never a link target.
 *
 * The fixture tenant has an existing primary `email|userId` with the verified
 * email foo@example.com: the account an attacker would want.
 */

const VICTIM_ID = "email|userId";
const VICTIM_EMAIL = "foo@example.com";

type TestEnv = Awaited<ReturnType<typeof getTestServer>>["env"];
type HookContext = Context<{ Bindings: Bindings; Variables: Variables }>;

async function markSelfService(
  env: TestEnv,
  selfService: ConnectionSelfService | null,
) {
  await env.data.connections.update("tenantId", "mock-strategy", {
    self_service: selfService,
  });
}

/** Logs in through the mock-strategy connection with the given upstream code. */
async function loginThroughConnection(
  server: Awaited<ReturnType<typeof getTestServer>>,
  code: string,
) {
  const { oauthApp, env } = server;
  const oauthClient = testClient(oauthApp, env);

  await oauthClient.authorize.$get(
    {
      query: {
        client_id: "clientId",
        redirect_uri: "https://example.com/callback",
        state: "state",
        connection: "mock-strategy",
        response_type: AuthorizationResponseType.TOKEN_ID_TOKEN,
      },
    },
    { headers: { origin: "https://example.com" } },
  );

  const response = await oauthClient.login.callback.$get({
    query: { state: "code", code },
  });
  expect(response.status).toEqual(302);
}

/** A context for driving the data hooks directly, as the app middleware does. */
function hookedData(env: TestEnv) {
  const ctx = {
    req: {
      method: "POST",
      url: "http://test",
      path: "/test",
      header: () => undefined,
      query: () => undefined,
      queries: () => ({}),
    },
    env,
    set: () => {},
    var: {
      ip: "127.0.0.1",
      useragent: "test-agent",
      client_id: "clientId",
      tenant_id: "tenantId",
    },
  };
  // The hook decorators read only the members above.
  return addDataHooks(ctx as unknown as HookContext, env.data);
}

describe("self-service SSO: email_verified guard", () => {
  it("does not link a login asserting an existing user's email from an unverified domain", async () => {
    const server = await getTestServer();
    const { env } = server;
    await markSelfService(env, { domains: [] });

    await loginThroughConnection(
      server,
      `asserts-verified:attacker:${VICTIM_EMAIL}`,
    );

    const attacker = await env.data.users.get(
      "tenantId",
      "mock-strategy|attacker",
    );
    expect(attacker).toBeTruthy();
    // The identity provider asserted `email_verified: true`; it is not trusted.
    expect(attacker?.email_verified).toBe(false);
    // ...so the login was not linked into the victim's account.
    expect(attacker?.linked_to).toBeFalsy();

    const victim = await env.data.users.get("tenantId", VICTIM_ID);
    expect(victim?.linked_to).toBeFalsy();
  });

  it("control: the same login on an ordinary connection links into the existing account", async () => {
    // Without the self-service marker the asserted email is trusted, so the
    // login above would have joined the victim's account. This is what the
    // guard prevents, and shows the test above can tell the difference.
    const server = await getTestServer();
    const { env } = server;

    await loginThroughConnection(
      server,
      `asserts-verified:attacker:${VICTIM_EMAIL}`,
    );

    const attacker = await env.data.users.get(
      "tenantId",
      "mock-strategy|attacker",
    );
    expect(attacker?.linked_to).toBe(VICTIM_ID);
  });

  it("does not trust a domain that is only pending verification", async () => {
    const server = await getTestServer();
    const { env } = server;
    await markSelfService(env, {
      domains: [{ domain: "example.com", status: "pending" }],
    });

    await loginThroughConnection(
      server,
      `asserts-verified:attacker:${VICTIM_EMAIL}`,
    );

    const attacker = await env.data.users.get(
      "tenantId",
      "mock-strategy|attacker",
    );
    expect(attacker?.email_verified).toBe(false);
    expect(attacker?.linked_to).toBeFalsy();
  });

  it("trusts the assertion inside a verified domain", async () => {
    const server = await getTestServer();
    const { env } = server;
    await markSelfService(env, {
      domains: [
        {
          domain: "Example.COM",
          status: "verified",
          verified_at: "2026-11-18T00:00:00.000Z",
        },
      ],
    });

    await loginThroughConnection(
      server,
      `asserts-verified:employee:${VICTIM_EMAIL}`,
    );

    const employee = await env.data.users.get(
      "tenantId",
      "mock-strategy|employee",
    );
    expect(employee?.email_verified).toBe(true);
    expect(employee?.linked_to).toBe(VICTIM_ID);
  });

  it.each(["on_each_login", "on_first_login", "never_on_login"] as const)(
    "clears a stored email_verified outside verified domains in %s mode",
    async (mode) => {
      const server = await getTestServer();
      const { env } = server;
      // A user created before the connection became self-service (an "edit
      // this connection" ticket), or while its domain was still verified.
      await env.data.users.create("tenantId", {
        user_id: "mock-strategy|stale",
        email: "stale@unverified.example",
        email_verified: true,
        provider: "mock-strategy",
        connection: "mock-strategy",
        is_social: true,
      });
      const connection = await env.data.connections.get(
        "tenantId",
        "mock-strategy",
      );
      await env.data.connections.update("tenantId", "mock-strategy", {
        options: { ...connection?.options, set_user_root_attributes: mode },
        self_service: { domains: [] },
      });

      await loginThroughConnection(
        server,
        "asserts-verified:stale:stale@unverified.example",
      );

      const user = await env.data.users.get("tenantId", "mock-strategy|stale");
      expect(user?.email_verified).toBe(false);
    },
  );
});

describe("self-service SSO: never a link target", () => {
  const LATER_EMAIL = "later@example.com";

  async function attackerFirst(
    server: Awaited<ReturnType<typeof getTestServer>>,
  ) {
    // The attacker's login comes first, claiming an email nobody has used yet.
    await markSelfService(server.env, { domains: [] });
    await loginThroughConnection(
      server,
      `asserts-verified:squatter:${LATER_EMAIL}`,
    );
  }

  it("a later sign-up with the same verified email is not linked into the attacker's account", async () => {
    const server = await getTestServer();
    const { env } = server;
    await attackerFirst(server);

    // The real owner of the address signs up with a verified email (e.g. a
    // one-time code). Built-in linking would pick the oldest primary with the
    // same email: the attacker's.
    const owner = await hookedData(env).users.create("tenantId", {
      user_id: "email|owner",
      email: LATER_EMAIL,
      email_verified: true,
      provider: "email",
      connection: "email",
      is_social: false,
      login_count: 0,
    });

    expect(owner.user_id).toBe("email|owner");
    const stored = await env.data.users.get("tenantId", "email|owner");
    expect(stored?.linked_to).toBeFalsy();
  });

  it("control: without the marker the later sign-up joins the older account", async () => {
    const server = await getTestServer();
    const { env } = server;
    await attackerFirst(server);
    // Same data, but the connection is no longer self-service.
    await markSelfService(env, null);

    await hookedData(env).users.create("tenantId", {
      user_id: "email|owner",
      email: LATER_EMAIL,
      email_verified: true,
      provider: "email",
      connection: "email",
      is_social: false,
      login_count: 0,
    });

    const stored = await env.data.users.get("tenantId", "email|owner");
    expect(stored?.linked_to).toBe("mock-strategy|squatter");
  });

  it("is left out of the candidates the account-linking hook and code hooks see", async () => {
    const server = await getTestServer();
    const { env } = server;
    await attackerFirst(server);

    const owner = await env.data.users.create("tenantId", {
      user_id: "email|owner",
      email: LATER_EMAIL,
      email_verified: true,
      provider: "email",
      connection: "email",
      is_social: false,
    });

    const unfiltered = await resolveLinkCandidates({
      userAdapter: env.data.users,
      tenantId: "tenantId",
      user: owner,
    });
    expect(unfiltered.map((u) => u.user_id)).toContain(
      "mock-strategy|squatter",
    );

    const filtered = await resolveLinkCandidates({
      userAdapter: env.data.users,
      connectionAdapter: env.data.connections,
      tenantId: "tenantId",
      user: owner,
    });
    expect(filtered.map((u) => u.user_id)).not.toContain(
      "mock-strategy|squatter",
    );

    const untrustedUser = unfiltered.find(
      (user) => user.user_id === "mock-strategy|squatter",
    )!;
    const candidatesForUntrustedUser = await resolveLinkCandidates({
      userAdapter: env.data.users,
      connectionAdapter: env.data.connections,
      tenantId: "tenantId",
      user: untrustedUser,
    });
    expect(candidatesForUntrustedUser).toEqual([]);
  });
});

describe("self-service SSO: internal state stays internal", () => {
  const selfService: ConnectionSelfService = {
    profile_id: "ssp_1",
    domains: [{ domain: "example.com", status: "verified" }],
  };

  it("is readable by the login flow but not returned by the Management API", async () => {
    const { managementApp, env } = await getTestServer();
    await markSelfService(env, selfService);

    // The adapter (and so the login flow) sees it...
    const stored = await env.data.connections.get("tenantId", "mock-strategy");
    expect(stored?.self_service).toEqual(selfService);

    const managementClient = testClient(managementApp, env);
    const token = await getAdminToken();
    const headers = { authorization: `Bearer ${token}` };

    // ...the API does not.
    const getResponse = await managementClient.connections[":id"].$get(
      { param: { id: "mock-strategy" }, header: { "tenant-id": "tenantId" } },
      { headers },
    );
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).not.toHaveProperty("self_service");

    const listResponse = await managementClient.connections.$get(
      { query: {}, header: { "tenant-id": "tenantId" } },
      { headers },
    );
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json();
    const listed = Array.isArray(listBody) ? listBody : listBody.connections;
    for (const connection of listed) {
      expect(connection).not.toHaveProperty("self_service");
    }

    // A PATCH cannot set or clear it, and its response does not show it.
    // `self_service` is not part of the API's body schema, so validation drops
    // it (a variable, not a literal, so the extra key type-checks).
    const patchBody = { display_name: "Mock", self_service: null };
    const patchResponse = await managementClient.connections[":id"].$patch(
      {
        param: { id: "mock-strategy" },
        json: patchBody,
        header: { "tenant-id": "tenantId" },
      },
      { headers },
    );
    expect(patchResponse.status).toBe(200);
    expect(await patchResponse.json()).not.toHaveProperty("self_service");
    const afterPatch = await env.data.connections.get(
      "tenantId",
      "mock-strategy",
    );
    expect(afterPatch?.self_service).toEqual(selfService);
  });

  it("is not exported", async () => {
    const { env } = await getTestServer();
    await markSelfService(env, selfService);

    const lines = await exportTenant(env.data, "tenantId", {});
    const exported = lines.filter((l) => l.entity === "connections");
    expect(exported.length).toBeGreaterThan(0);
    for (const line of exported) {
      expect(line.data).not.toHaveProperty("self_service");
    }
  });
});

describe("self-service SSO: domain trust rules", () => {
  const selfService: ConnectionSelfService = {
    domains: [
      { domain: "example.com", status: "verified" },
      { domain: "pending.example", status: "pending" },
    ],
  };

  it("matches the email's domain exactly, ignoring case", () => {
    expect(isEmailDomainVerified(selfService, "a@EXAMPLE.com")).toBe(true);
    expect(isEmailDomainVerified(selfService, "a@sub.example.com")).toBe(false);
    expect(isEmailDomainVerified(selfService, "a@pending.example")).toBe(false);
    expect(isEmailDomainVerified(selfService, "not-an-email")).toBe(false);
    expect(isEmailDomainVerified(selfService, undefined)).toBe(false);
  });

  it("never overrides an ordinary connection", () => {
    expect(isUntrustedSelfServiceEmail(undefined, "a@x.example")).toBe(false);
    expect(isUntrustedSelfServiceEmail(null, "a@x.example")).toBe(false);
  });

  it("distrusts a self-service connection outside its verified domains", () => {
    expect(isUntrustedSelfServiceEmail(selfService, "a@example.com")).toBe(
      false,
    );
    expect(isUntrustedSelfServiceEmail(selfService, "a@other.example")).toBe(
      true,
    );
    expect(isUntrustedSelfServiceEmail(selfService, "a@pending.example")).toBe(
      true,
    );
    expect(isUntrustedSelfServiceEmail({ domains: [] }, "a@example.com")).toBe(
      true,
    );
  });
});
