import { describe, it, expect } from "vitest";
import { testClient } from "hono/testing";
import { getAdminToken } from "../../helpers/token";
import { getTestServer } from "../../helpers/test-server";

describe("log-streams", () => {
  it("creates, gets, lists, updates, and deletes a log stream", async () => {
    const { managementApp, env } = await getTestServer();
    const client = testClient(managementApp, env);
    const token = await getAdminToken();

    // Create
    const create = await client["log-streams"].$post(
      {
        header: { "tenant-id": "tenantId" },
        json: {
          name: "loki",
          type: "http",
          status: "active",
          sink: {
            http_endpoint: "https://logs.example.com",
            http_content_type: "application/json",
            http_content_format: "JSONLINES",
            http_authorization: "Bearer x",
          },
        },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: string; name: string };
    expect(created.id).toBeTruthy();
    expect(created.name).toBe("loki");

    // Get
    const get = await client["log-streams"][":id"].$get(
      {
        header: { "tenant-id": "tenantId" },
        param: { id: created.id },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(get.status).toBe(200);
    expect((await get.json()).name).toBe("loki");

    // List
    const list = await client["log-streams"].$get(
      { header: { "tenant-id": "tenantId" } },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(list.status).toBe(200);
    expect(await list.json()).toHaveLength(1);

    // Update
    const patch = await client["log-streams"][":id"].$patch(
      {
        header: { "tenant-id": "tenantId" },
        param: { id: created.id },
        json: { status: "paused" },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(patch.status).toBe(200);
    expect((await patch.json()).status).toBe("paused");

    // Delete
    const del = await client["log-streams"][":id"].$delete(
      {
        header: { "tenant-id": "tenantId" },
        param: { id: created.id },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(del.status).toBe(204);

    const afterDelete = await client["log-streams"].$get(
      { header: { "tenant-id": "tenantId" } },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(await afterDelete.json()).toEqual([]);
  });
});
