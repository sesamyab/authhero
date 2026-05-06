import { describe, it, expect } from "vitest";
import { testClient } from "hono/testing";
import { Strategy } from "@authhero/adapter-interfaces";
import { getAdminToken } from "../../helpers/token";
import { getTestServer } from "../../helpers/test-server";

async function setup() {
  const { managementApp, env } = await getTestServer();
  const client = testClient(managementApp, env);
  const token = await getAdminToken();
  const tenantId = `org-conn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Connections / organizations have FKs to the tenant row, so seed it first.
  await env.data.tenants.create({
    id: tenantId,
    friendly_name: tenantId,
    audience: "https://example.com",
    sender_email: "test@example.com",
    sender_name: "Test",
  });

  const org = await env.data.organizations.create(tenantId, {
    name: "acme",
    display_name: "Acme",
  });

  const conn = await env.data.connections.create(tenantId, {
    name: "tf-database",
    strategy: Strategy.USERNAME_PASSWORD,
    options: {},
  });

  return { client, env, token, tenantId, org, conn };
}

describe("organization enabled_connections", () => {
  it("creates, lists, gets, updates and deletes a connection on an organization", async () => {
    const { client, token, tenantId, org, conn } = await setup();

    // Empty list initially.
    const empty = await client.organizations[":id"].enabled_connections.$get(
      {
        param: { id: org.id },
        header: { "tenant-id": tenantId },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(empty.status).toBe(200);
    const emptyBody = (await empty.json()) as { connections: unknown[] };
    expect(emptyBody.connections).toEqual([]);

    // POST creates the link.
    const created = await client.organizations[":id"].enabled_connections.$post(
      {
        param: { id: org.id },
        header: { "tenant-id": tenantId },
        json: {
          connection_id: conn.id,
          assign_membership_on_login: true,
          show_as_button: false,
          is_signup_enabled: false,
        },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as Record<string, unknown>;
    expect(createdBody).toMatchObject({
      connection_id: conn.id,
      assign_membership_on_login: true,
      show_as_button: false,
      is_signup_enabled: false,
    });

    // POST again → 409.
    const dup = await client.organizations[":id"].enabled_connections.$post(
      {
        param: { id: org.id },
        header: { "tenant-id": tenantId },
        json: { connection_id: conn.id },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(dup.status).toBe(409);

    // GET single
    const got = await client.organizations[":id"].enabled_connections[
      ":connection_id"
    ].$get(
      {
        param: { id: org.id, connection_id: conn.id },
        header: { "tenant-id": tenantId },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(got.status).toBe(200);

    // PATCH flips a flag.
    const patched = await client.organizations[":id"].enabled_connections[
      ":connection_id"
    ].$patch(
      {
        param: { id: org.id, connection_id: conn.id },
        header: { "tenant-id": tenantId },
        json: { assign_membership_on_login: false },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as Record<string, unknown>;
    expect(patchedBody.assign_membership_on_login).toBe(false);

    // LIST returns one row.
    const list = await client.organizations[":id"].enabled_connections.$get(
      {
        param: { id: org.id },
        header: { "tenant-id": tenantId },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { connections: unknown[] };
    expect(listBody.connections).toHaveLength(1);

    // DELETE removes it.
    const deleted = await client.organizations[":id"].enabled_connections[
      ":connection_id"
    ].$delete(
      {
        param: { id: org.id, connection_id: conn.id },
        header: { "tenant-id": tenantId },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(deleted.status).toBe(204);

    // After delete, list is empty again.
    const finalList =
      await client.organizations[":id"].enabled_connections.$get(
        {
          param: { id: org.id },
          header: { "tenant-id": tenantId },
        },
        { headers: { authorization: `Bearer ${token}` } },
      );
    const finalBody = (await finalList.json()) as { connections: unknown[] };
    expect(finalBody.connections).toEqual([]);
  });

  it("returns 404 when organization is missing on POST", async () => {
    const { client, token, tenantId, conn } = await setup();
    const res = await client.organizations[":id"].enabled_connections.$post(
      {
        param: { id: "org_does_not_exist" },
        header: { "tenant-id": tenantId },
        json: { connection_id: conn.id },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when connection is missing on POST", async () => {
    const { client, token, tenantId, org } = await setup();
    const res = await client.organizations[":id"].enabled_connections.$post(
      {
        param: { id: org.id },
        header: { "tenant-id": tenantId },
        json: { connection_id: "conn_does_not_exist" },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(400);
  });
});
