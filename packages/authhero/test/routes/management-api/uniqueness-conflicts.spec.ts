import { describe, it, expect } from "vitest";
import { testClient } from "hono/testing";
import type { DataAdapters } from "@authhero/adapter-interfaces";
import { getAdminToken } from "../../helpers/token";
import { getTestServer } from "../../helpers/test-server";

// Issue #1589: resource-server identifiers and organization names are unique
// per tenant. The route pre-checks must find an exact duplicate wherever it
// is in the list, PATCH must check too, and a violation that slips past the
// pre-check (a concurrent write) must still come back as Auth0's 409 body.

const TENANT = "tenantId";

const RS_CONFLICT = (identifier: string) => ({
  statusCode: 409,
  error: "Conflict",
  message: `A resource server already exists with identifer ${identifier}`,
  errorCode: "resource_server_conflict",
});

const ORG_CONFLICT = {
  statusCode: 409,
  error: "Conflict",
  message: "An organization with this name already exists.",
  errorCode: "organization_conflict",
};

// Hides every row from list() so the route's pre-check misses and the write
// reaches the database's unique index, as a concurrent request would. With
// `after`, the first `after` list calls are hidden and later ones pass
// through, so the route's post-error lookup sees the clashing row.
function hideListResults(after = Infinity) {
  return (data: DataAdapters): DataAdapters => {
    let rsCalls = 0;
    let orgCalls = 0;
    return {
      ...data,
      resourceServers: {
        ...data.resourceServers,
        list: async (tenantId, params) =>
          rsCalls++ < after
            ? { resource_servers: [], start: 0, limit: 0, length: 0 }
            : data.resourceServers.list(tenantId, params),
      },
      organizations: {
        ...data.organizations,
        list: async (tenantId, params) =>
          orgCalls++ < after
            ? { organizations: [], start: 0, limit: 0, length: 0 }
            : data.organizations.list(tenantId, params),
      },
    };
  };
}

describe("resource-server identifier uniqueness", () => {
  // 55 identifiers that all contain the target as a substring, created
  // before it, push the exact match onto the second page of a substring
  // search.
  async function seedSubstringMatches(data: DataAdapters, target: string) {
    for (let i = 0; i < 55; i++) {
      await data.resourceServers.create(TENANT, {
        name: `Near ${i}`,
        identifier: `${target}/v${i}`,
      });
    }
    return data.resourceServers.create(TENANT, {
      name: "Target",
      identifier: target,
    });
  }

  it("returns 409 on POST when the duplicate is past the first page of matches", async () => {
    const { managementApp, env } = await getTestServer();
    const client = testClient(managementApp, env);
    const token = await getAdminToken();
    const target = "https://paged.example.com";
    await seedSubstringMatches(env.data, target);

    const response = await client["resource-servers"].$post(
      {
        json: { identifier: target, name: "Dup" },
        header: { "tenant-id": TENANT },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(RS_CONFLICT(target));
  });

  it("resolves a resource server by identifier past the first page", async () => {
    const { managementApp, env } = await getTestServer();
    const client = testClient(managementApp, env);
    const token = await getAdminToken();
    const target = "https://paged.example.com";
    const created = await seedSubstringMatches(env.data, target);

    const response = await client["resource-servers"][":id"].$get(
      // SDKs send the identifier URL-encoded in the path.
      {
        param: { id: encodeURIComponent(target) },
        header: { "tenant-id": TENANT },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: created.id,
      identifier: target,
    });
  });

  it("returns 409 on PATCH when the new identifier is taken", async () => {
    const { managementApp, env } = await getTestServer();
    const client = testClient(managementApp, env);
    const token = await getAdminToken();
    await env.data.resourceServers.create(TENANT, {
      name: "A",
      identifier: "https://a.example.com",
    });
    const b = await env.data.resourceServers.create(TENANT, {
      name: "B",
      identifier: "https://b.example.com",
    });

    const response = await client["resource-servers"][":id"].$patch(
      {
        param: { id: b.id! },
        json: { identifier: "https://a.example.com" },
        header: { "tenant-id": TENANT },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(RS_CONFLICT("https://a.example.com"));
  });

  it("allows PATCH that resends the resource server's own identifier", async () => {
    const { managementApp, env } = await getTestServer();
    const client = testClient(managementApp, env);
    const token = await getAdminToken();
    const rs = await env.data.resourceServers.create(TENANT, {
      name: "A",
      identifier: "https://a.example.com",
    });

    const response = await client["resource-servers"][":id"].$patch(
      {
        param: { id: rs.id! },
        json: { identifier: "https://a.example.com", name: "A2" },
        header: { "tenant-id": TENANT },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ name: "A2" });
  });

  it("maps a unique violation the pre-check missed on POST to the conflict body", async () => {
    // Pre-check hidden (1st list call); post-error lookup sees the row.
    const { managementApp, env } = await getTestServer({
      wrapDataAdapter: hideListResults(1),
    });
    const client = testClient(managementApp, env);
    const token = await getAdminToken();
    await env.data.resourceServers.create(TENANT, {
      name: "A",
      identifier: "https://race.example.com",
    });

    const response = await client["resource-servers"].$post(
      {
        json: { identifier: "https://race.example.com", name: "A again" },
        header: { "tenant-id": TENANT },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(
      RS_CONFLICT("https://race.example.com"),
    );
  });

  it("maps a unique violation the pre-check missed on PATCH to the conflict body", async () => {
    const { managementApp, env } = await getTestServer({
      wrapDataAdapter: hideListResults(),
    });
    const client = testClient(managementApp, env);
    const token = await getAdminToken();
    await env.data.resourceServers.create(TENANT, {
      name: "A",
      identifier: "https://a.example.com",
    });
    const b = await env.data.resourceServers.create(TENANT, {
      name: "B",
      identifier: "https://b.example.com",
    });

    const response = await client["resource-servers"][":id"].$patch(
      {
        param: { id: b.id! },
        json: { identifier: "https://a.example.com" },
        header: { "tenant-id": TENANT },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(RS_CONFLICT("https://a.example.com"));
  });
});

describe("organization name uniqueness", () => {
  it("returns 409 on PATCH when the new name is taken", async () => {
    const { managementApp, env } = await getTestServer();
    const client = testClient(managementApp, env);
    const token = await getAdminToken();
    await env.data.organizations.create(TENANT, { name: "acme" });
    const other = await env.data.organizations.create(TENANT, {
      name: "globex",
    });

    const response = await client.organizations[":id"].$patch(
      {
        param: { id: other.id },
        json: { name: "acme" },
        header: { "tenant-id": TENANT },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(ORG_CONFLICT);
    expect((await env.data.organizations.get(TENANT, other.id))?.name).toBe(
      "globex",
    );
  });

  it("allows PATCH that resends the organization's own name", async () => {
    const { managementApp, env } = await getTestServer();
    const client = testClient(managementApp, env);
    const token = await getAdminToken();
    const org = await env.data.organizations.create(TENANT, { name: "acme" });

    const response = await client.organizations[":id"].$patch(
      {
        param: { id: org.id },
        json: { name: "acme", display_name: "Acme Inc" },
        header: { "tenant-id": TENANT },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      name: "acme",
      display_name: "Acme Inc",
    });
  });

  it("maps a unique violation the pre-check missed on POST to the conflict body", async () => {
    const { managementApp, env } = await getTestServer({
      wrapDataAdapter: hideListResults(1),
    });
    const client = testClient(managementApp, env);
    const token = await getAdminToken();
    await env.data.organizations.create(TENANT, { name: "acme" });

    const response = await client.organizations.$post(
      { json: { name: "acme" }, header: { "tenant-id": TENANT } },
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(ORG_CONFLICT);
  });

  it("maps a unique violation the pre-check missed on PATCH to the conflict body", async () => {
    const { managementApp, env } = await getTestServer({
      wrapDataAdapter: hideListResults(),
    });
    const client = testClient(managementApp, env);
    const token = await getAdminToken();
    await env.data.organizations.create(TENANT, { name: "acme" });
    const other = await env.data.organizations.create(TENANT, {
      name: "globex",
    });

    const response = await client.organizations[":id"].$patch(
      {
        param: { id: other.id },
        json: { name: "acme" },
        header: { "tenant-id": TENANT },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(ORG_CONFLICT);
  });

  it("does not report a duplicate caller-supplied id as a name conflict", async () => {
    const { managementApp, env } = await getTestServer();
    const client = testClient(managementApp, env);
    const token = await getAdminToken();
    await env.data.organizations.create(TENANT, {
      id: "org_fixed",
      name: "acme",
    });

    const response = await client.organizations.$post(
      {
        json: { id: "org_fixed", name: "globex" },
        header: { "tenant-id": TENANT },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).not.toEqual(ORG_CONFLICT);
  });
});
