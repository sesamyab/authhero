import { describe, expect, it } from "vitest";
import { getTestServer } from "../helpers/test-server";

const invite = (email = "new@example.com") => ({
  kind: "invite" as const,
  requested_by: "auth0|admin",
  payload: { email, roles: ["rol_1"] },
});

describe("tenant member requests storage", () => {
  it("creates a pending request that only its tenant can read", async () => {
    const { data } = await getTestServer();
    const store = data.tenantMemberRequests!;

    const created = await store.create("tenant-a", invite());

    expect(created).toMatchObject({
      id: expect.stringMatching(/^tmr_/),
      tenant_id: "tenant-a",
      kind: "invite",
      status: "pending",
      requested_by: "auth0|admin",
      payload: { email: "new@example.com", roles: ["rol_1"] },
    });
    expect(created.notified_at ?? null).toBeNull();
    expect(await store.get("tenant-a", created.id)).toEqual(created);
    expect(await store.get("tenant-b", created.id)).toBeNull();
  });

  it("lists newest first, by status and by whether the control plane was told", async () => {
    const { data } = await getTestServer();
    const store = data.tenantMemberRequests!;
    const first = await store.create("tenant-a", invite("one@example.com"));
    const second = await store.create("tenant-a", invite("two@example.com"));
    await store.create("tenant-b", invite("other@example.com"));
    await store.update("tenant-a", first.id, {
      notified_at: "2026-01-01T00:00:00.000Z",
    });
    await store.update(
      "tenant-a",
      second.id,
      { status: "failed", error: "not a member" },
      "pending",
    );

    const all = await store.list("tenant-a");
    expect(all.requests.map((r) => r.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(
      (await store.list("tenant-a", { status: "failed" })).requests.map(
        (r) => r.id,
      ),
    ).toEqual([second.id]);
    expect(
      (await store.list("tenant-a", { unnotified: true })).requests.map(
        (r) => r.id,
      ),
    ).toEqual([second.id]);
    expect(
      (await store.list("tenant-a", { created_before: "2000-01-01T00:00:00Z" }))
        .requests,
    ).toEqual([]);
  });

  it("finishes a pending request exactly once", async () => {
    const { data } = await getTestServer();
    const store = data.tenantMemberRequests!;
    const { id } = await store.create("tenant-a", invite());

    const outcomes = await Promise.all([
      store.update(
        "tenant-a",
        id,
        { status: "succeeded", result: { invitation_id: "inv_1" } },
        "pending",
      ),
      store.update(
        "tenant-a",
        id,
        { status: "failed", error: "nope" },
        "pending",
      ),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const row = await store.get("tenant-a", id);
    expect(row!.status).not.toBe("pending");
  });

  it("does not update an unknown request or another tenant's", async () => {
    const { data } = await getTestServer();
    const store = data.tenantMemberRequests!;
    const { id } = await store.create("tenant-a", invite());

    expect(await store.update("tenant-b", id, { status: "failed" })).toBe(
      false,
    );
    expect(await store.update("tenant-a", "tmr_missing", {})).toBe(false);
    expect((await store.get("tenant-a", id))!.status).toBe("pending");
  });

  it("round-trips a result and removes only old finished requests", async () => {
    const { data } = await getTestServer();
    const store = data.tenantMemberRequests!;
    const done = await store.create("tenant-a", invite("done@example.com"));
    const open = await store.create("tenant-a", invite("open@example.com"));
    await store.update("tenant-a", done.id, {
      status: "succeeded",
      result: { invitation_id: "inv_1" },
      finished_at: "2026-01-01T00:00:00.000Z",
    });

    expect((await store.get("tenant-a", done.id))!.result).toEqual({
      invitation_id: "inv_1",
    });
    expect(await store.cleanup("2025-01-01T00:00:00.000Z")).toBe(0);
    expect(await store.cleanup("2027-01-01T00:00:00.000Z")).toBe(1);
    expect(await store.get("tenant-a", done.id)).toBeNull();
    expect(await store.get("tenant-a", open.id)).not.toBeNull();
  });

  it("stamps finished_at when a request ends without one, so it can be cleaned up", async () => {
    const { data } = await getTestServer();
    const store = data.tenantMemberRequests!;
    const { id } = await store.create("tenant-a", invite());

    await store.update(
      "tenant-a",
      id,
      { status: "failed", error: "no" },
      "pending",
    );

    const row = await store.get("tenant-a", id);
    expect(row!.finished_at).toEqual(expect.any(String));
    expect(await store.cleanup("2999-01-01T00:00:00.000Z")).toBe(1);
  });
});
