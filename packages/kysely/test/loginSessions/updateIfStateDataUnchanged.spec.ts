import { describe, expect, it } from "vitest";
import type { DataAdapters } from "@authhero/adapter-interfaces";
import { getTestServer } from "../helpers/test-server";

// Compare-and-swap on login session state_data, used by authhero to reserve
// per-session send slots atomically.
describe("loginSessions.updateIfStateDataUnchanged", () => {
  async function createSession(data: DataAdapters) {
    await data.tenants.create({
      id: "tenantId",
      friendly_name: "Test Tenant",
      audience: "https://example.com",
      sender_email: "login@example.com",
      sender_name: "SenderName",
    });
    return data.loginSessions.create("tenantId", {
      csrf_token: "csrf",
      authParams: { client_id: "clientId" },
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
  }

  function cas(
    data: DataAdapters,
    id: string,
    expected: string | undefined,
    stateData: string,
  ) {
    const update = data.loginSessions.updateIfStateDataUnchanged;
    if (!update) throw new Error("updateIfStateDataUnchanged not implemented");
    return update("tenantId", id, expected, { state_data: stateData });
  }

  it("applies the update only while state_data is unchanged", async () => {
    const { data } = await getTestServer();
    const { id } = await createSession(data);

    expect(await cas(data, id, undefined, '{"n":1}')).toBe(true);
    expect((await data.loginSessions.get("tenantId", id))?.state_data).toBe(
      '{"n":1}',
    );

    // Stale expectations do not write.
    expect(await cas(data, id, undefined, '{"n":9}')).toBe(false);
    expect(await cas(data, id, '{"n":0}', '{"n":9}')).toBe(false);

    expect(await cas(data, id, '{"n":1}', '{"n":2}')).toBe(true);
    expect((await data.loginSessions.get("tenantId", id))?.state_data).toBe(
      '{"n":2}',
    );
  });

  it("treats a cleared state_data as empty", async () => {
    const { data } = await getTestServer();
    const { id } = await createSession(data);
    await data.loginSessions.update("tenantId", id, { state_data: '{"n":1}' });
    await data.loginSessions.update("tenantId", id, { state_data: "" });

    expect(await cas(data, id, undefined, '{"n":2}')).toBe(true);
  });

  it("returns false for a missing session", async () => {
    const { data } = await getTestServer();
    await data.tenants.create({
      id: "tenantId",
      friendly_name: "Test Tenant",
      audience: "https://example.com",
      sender_email: "login@example.com",
      sender_name: "SenderName",
    });
    expect(await cas(data, "missing", undefined, '{"n":1}')).toBe(false);
  });

  it("lets concurrent increments reserve at most max slots", async () => {
    const { data } = await getTestServer();
    const { id } = await createSession(data);
    const max = 5;

    async function reserve() {
      for (let attempt = 0; attempt < 20; attempt++) {
        const current = await data.loginSessions.get("tenantId", id);
        const n = current?.state_data ? JSON.parse(current.state_data).n : 0;
        if (n >= max) return false;
        const next = JSON.stringify({ n: n + 1 });
        if (await cas(data, id, current?.state_data || undefined, next)) {
          return true;
        }
      }
      return false;
    }

    const results = await Promise.all(Array.from({ length: 20 }, reserve));

    expect(results.filter(Boolean)).toHaveLength(max);
    const stored = await data.loginSessions.get("tenantId", id);
    expect(JSON.parse(stored?.state_data ?? "{}").n).toBe(max);
  });
});
