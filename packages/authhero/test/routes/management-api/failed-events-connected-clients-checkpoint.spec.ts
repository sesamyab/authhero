import { describe, it, expect } from "vitest";
import { testClient } from "hono/testing";
import { getAdminToken } from "../../helpers/token";
import { getTestServer } from "../../helpers/test-server";

// Checkpoint (from/take) pagination on GET /failed-events and
// GET /users/{id}/connected-clients.
describe("failed events and connected clients checkpoint pagination", () => {
  const tenantId = "tenantId";
  const pad = (i: number) => i.toString().padStart(2, "0");

  it("walks failed events", async () => {
    const { managementApp, env } = await getTestServer();
    const client = testClient(managementApp, env) as any;
    const token = await getAdminToken();

    for (let i = 0; i < 25; i++) {
      const id = await env.data.outbox!.create(tenantId, {
        tenant_id: tenantId,
        event_type: "hook.post-user-registration",
        log_type: "sapi",
        category: "system",
        actor: { type: "system" },
        target: { type: "user", id: "email|userId" },
        request: { method: "POST", path: "/users", ip: "127.0.0.1" },
        hostname: "localhost",
        timestamp: new Date().toISOString(),
      });
      await env.data.outbox!.deadLetter(id, "webhook returned 500");
    }

    const seen: string[] = [];
    let from: string | undefined;
    let pages = 0;
    do {
      const response = await client["failed-events"].$get(
        {
          query: { take: "10", ...(from ? { from } : {}) },
          header: { "tenant-id": tenantId },
        },
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect("start" in body).toBe(false);
      seen.push(...body.events.map((e: { id: string }) => e.id));
      from = body.next;
      if (from) expect(from).not.toMatch(/^\d+$/);
      if (++pages > 6) throw new Error("cursor walk did not terminate");
    } while (from);
    expect(new Set(seen).size).toBe(25);
    expect(pages).toBe(3);
  });

  it("walks connected clients and drops soft-deleted ones", async () => {
    const { managementApp, env } = await getTestServer();
    const client = testClient(managementApp, env) as any;
    const token = await getAdminToken();
    const userId = "email|owner";

    for (let i = 0; i < 25; i++) {
      await env.data.clients.create(tenantId, {
        client_id: `owned-${pad(i)}`,
        name: `Owned ${i}`,
        owner_user_id: userId,
        ...(i === 0 ? { client_metadata: { status: "deleted" } } : {}),
      });
    }
    await env.data.clients.create(tenantId, {
      client_id: "someone-elses",
      name: "Other",
      owner_user_id: "email|other",
    });

    const seen: string[] = [];
    let from: string | undefined;
    let pages = 0;
    do {
      const response = await client.users[":user_id"]["connected-clients"].$get(
        {
          param: { user_id: userId },
          query: { take: "10", ...(from ? { from } : {}) },
          header: { "tenant-id": tenantId },
        },
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(Array.isArray(body)).toBe(false);
      seen.push(
        ...body.connected_clients.map(
          (c: { client_id: string }) => c.client_id,
        ),
      );
      from = body.next;
      if (++pages > 6) throw new Error("cursor walk did not terminate");
    } while (from);

    expect(seen).toHaveLength(24); // the soft-deleted one is dropped
    expect(new Set(seen).size).toBe(24);
    expect(seen).not.toContain("someone-elses");
    expect(pages).toBe(3);
  });
});
