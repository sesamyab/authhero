import { beforeEach, describe, expect, it } from "vitest";
import {
  AuditEventInsert,
  DataAdapters,
  OutboxAdapter,
  decodeCursor,
} from "@authhero/adapter-interfaces";
import { getTestServer } from "../helpers/test-server";

function makeEvent(tenantId: string): AuditEventInsert {
  return {
    tenant_id: tenantId,
    event_type: "hook.post-user-registration",
    log_type: "sapi",
    category: "system",
    actor: { type: "system" },
    target: { type: "user", id: "email|u1" },
    request: { method: "POST", path: "/", ip: "" },
    hostname: "",
    timestamp: "2026-07-09T00:00:00.000Z",
  };
}

// Checkpoint (from/take) pagination for the failed (dead-lettered) events list.
describe("outbox adapter — listFailed keyset pagination (from/take)", () => {
  let data: DataAdapters;
  let outbox: OutboxAdapter;

  beforeEach(async () => {
    ({ data } = await getTestServer());
    if (!data.outbox) throw new Error("adapter must expose outbox");
    outbox = data.outbox;
    for (const id of ["tenantId", "otherTenant"]) {
      await data.tenants.create({
        id,
        friendly_name: id,
        audience: "https://example.com",
        sender_email: "login@example.com",
        sender_name: "SenderName",
      });
    }
    for (let i = 0; i < 25; i++) {
      const id = await outbox.create("tenantId", makeEvent("tenantId"));
      await outbox.deadLetter(id, "webhook returned 500");
    }
    // Pending and other-tenant events must never show up in the walk.
    await outbox.create("tenantId", makeEvent("tenantId"));
    const other = await outbox.create("otherTenant", makeEvent("otherTenant"));
    await outbox.deadLetter(other, "boom");
  });

  it("walks every failed event of the tenant exactly once via next", async () => {
    const seen: string[] = [];
    let from: string | undefined;
    let pages = 0;
    for (;;) {
      const res = await outbox.listFailed("tenantId", { take: 10, from });
      pages++;
      seen.push(...res.events.map((e) => e.id));
      if (!res.next) break;
      from = res.next;
      if (pages > 10) throw new Error("cursor walk did not terminate");
    }
    expect(new Set(seen).size).toBe(25);
    expect(seen).toHaveLength(25);
    expect(pages).toBe(3);
  });

  it("emits an opaque cursor and keeps the offset list untouched", async () => {
    const first = await outbox.listFailed("tenantId", { take: 10 });
    expect(decodeCursor(first.next!)).not.toBeNull();
    expect(first.next).not.toMatch(/^\d+$/);

    const offset = await outbox.listFailed("tenantId", {
      page: 0,
      per_page: 10,
      include_totals: true,
    });
    expect(offset.events).toHaveLength(10);
    expect(offset.length).toBe(25);
    expect(offset.next).toBeUndefined();
  });
});
