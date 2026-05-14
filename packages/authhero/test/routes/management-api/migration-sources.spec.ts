import { describe, it, expect } from "vitest";
import { testClient } from "hono/testing";
import { getAdminToken } from "../../helpers/token";
import { getTestServer } from "../../helpers/test-server";

describe("migration-sources", () => {
  it("creates, gets, lists, updates, and deletes a migration source; client_secret is redacted on responses", async () => {
    const { managementApp, env } = await getTestServer();
    const client = testClient(managementApp, env);
    const token = await getAdminToken();

    // Create
    const create = await client["migration-sources"].$post(
      {
        header: { "tenant-id": "tenantId" },
        json: {
          name: "Upstream Auth0",
          provider: "auth0",
          connection: "auth0",
          enabled: true,
          credentials: {
            domain: "tenant.auth0.com",
            client_id: "upstream-cid",
            client_secret: "secret-value",
          },
        },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as {
      id: string;
      credentials: { client_secret: string; client_id: string };
    };
    expect(created.id).toBeTruthy();
    // client_secret must be redacted on every response.
    expect(created.credentials.client_secret).toBe("***");
    expect(created.credentials.client_id).toBe("upstream-cid");

    // Get
    const get = await client["migration-sources"][":id"].$get(
      {
        header: { "tenant-id": "tenantId" },
        param: { id: created.id },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(get.status).toBe(200);
    const got = (await get.json()) as {
      credentials: { client_secret: string };
    };
    expect(got.credentials.client_secret).toBe("***");

    // List
    const list = await client["migration-sources"].$get(
      { header: { "tenant-id": "tenantId" } },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(list.status).toBe(200);
    const listed = (await list.json()) as Array<{
      credentials: { client_secret: string };
    }>;
    expect(listed).toHaveLength(1);
    expect(listed[0].credentials.client_secret).toBe("***");

    // Underlying row keeps the real secret (encryption at rest is a follow-up).
    const row = await env.data.migrationSources!.get("tenantId", created.id);
    expect(row?.credentials.client_secret).toBe("secret-value");

    // Update
    const patch = await client["migration-sources"][":id"].$patch(
      {
        header: { "tenant-id": "tenantId" },
        param: { id: created.id },
        json: { enabled: false },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as {
      enabled: boolean;
      credentials: { client_secret: string };
    };
    expect(patched.enabled).toBe(false);
    expect(patched.credentials.client_secret).toBe("***");

    // Delete
    const del = await client["migration-sources"][":id"].$delete(
      {
        header: { "tenant-id": "tenantId" },
        param: { id: created.id },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(del.status).toBe(204);

    const afterDelete = await client["migration-sources"].$get(
      { header: { "tenant-id": "tenantId" } },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(await afterDelete.json()).toEqual([]);
  });

  it("rejects unauthenticated requests", async () => {
    const { managementApp, env } = await getTestServer();
    const client = testClient(managementApp, env);

    const list = await client["migration-sources"].$get({
      header: { "tenant-id": "tenantId" },
    });
    expect(list.status).toBe(401);
  });
});
