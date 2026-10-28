import { describe, expect, it } from "vitest";
import { getTestServer } from "../helpers/test-server";
import type { DeviceCode } from "@authhero/adapter-interfaces";

const row = (
  suffix = "one",
  expires_at = "2030-01-01T00:00:00.000Z",
): DeviceCode => ({
  device_code_hash: `device-${suffix}`,
  user_code_hash: `user-${suffix}`,
  client_id: "client",
  status: "pending",
  created_at: "2026-01-01T00:00:00.000Z",
  expires_at,
  interval: 5,
  version: 0,
});
describe("device authorization storage", () => {
  it("isolates tenants and enforces code uniqueness", async () => {
    const { data } = await getTestServer();
    const store = data.deviceCodes!;
    await store.create("tenant-a", row());
    await store.create("tenant-b", row());
    expect(await store.get("tenant-c", "device-one")).toBeNull();
    expect(await store.getByUserCode("tenant-c", "user-one")).toBeNull();
    expect(await store.getByUserCode("tenant-a", "user-one")).toEqual(row());
    await expect(store.create("tenant-a", row())).rejects.toThrow();
    await expect(
      store.create("tenant-a", { ...row("two"), user_code_hash: "user-one" }),
    ).rejects.toThrow();
    expect(await store.get("tenant-a", "device-one")).toEqual(row());
  });
  it("allows exactly one concurrent decision or redemption", async () => {
    const { data } = await getTestServer();
    const store = data.deviceCodes!;
    await store.create("tenant-a", row());
    const decisions = await Promise.all([
      store.update("tenant-a", "device-one", 0, {
        status: "approved",
        login_id: "browser-a",
      }),
      store.update("tenant-a", "device-one", 0, {
        status: "denied",
        login_id: "browser-b",
      }),
    ]);
    expect(decisions.filter(Boolean)).toHaveLength(1);
    const decided = (await store.get("tenant-a", "device-one"))!;
    expect(decided.version).toBe(1);
    const consumed = await Promise.all(
      Array.from({ length: 10 }, () =>
        store.update("tenant-a", "device-one", 1, { status: "consumed" }),
      ),
    );
    expect(consumed.filter(Boolean)).toHaveLength(1);
    expect((await store.get("tenant-a", "device-one"))?.version).toBe(2);
    expect(
      await store.update("tenant-b", "device-one", 2, { status: "approved" }),
    ).toBe(false);
  });
  it("increments concurrent throttle requests exactly once each, scoped by tenant", async () => {
    const { data } = await getTestServer();
    const store = data.deviceCodes!;
    const counts = await Promise.all(
      Array.from({ length: 10 }, () =>
        store.incrementAttempts(
          "tenant-a",
          "bucket",
          "2030-01-01T00:00:00.000Z",
        ),
      ),
    );
    expect(counts.sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(
      await store.incrementAttempts(
        "tenant-b",
        "bucket",
        "2030-01-01T00:00:00.000Z",
      ),
    ).toBe(1);
  });
  it("cleans expired grants and throttle buckets while retaining live rows", async () => {
    const { data } = await getTestServer();
    const store = data.deviceCodes!;
    await store.create("tenant-a", row("expired", "2020-01-01T00:00:00.000Z"));
    await store.create("tenant-b", row("live"));
    await store.incrementAttempts(
      "tenant-a",
      "expired",
      "2020-01-01T00:00:00.000Z",
    );
    expect(await store.cleanup("2026-01-01T00:00:00.000Z")).toBe(2);
    expect(await store.get("tenant-a", "device-expired")).toBeNull();
    expect(await store.getByUserCode("tenant-a", "user-expired")).toBeNull();
    expect(await store.get("tenant-b", "device-live")).not.toBeNull();
    expect(await store.cleanup("2026-01-01T00:00:00.000Z")).toBe(0);
  });
});
