import { describe, expect, it } from "vitest";
import { isSyncedRowId, rowIdOf } from "./syncedRows";

describe("isSyncedRowId", () => {
  it("recognises the ids a sync writes", () => {
    expect(isSyncedRowId("con_sy0123456789abcde")).toBe(true);
    expect(isSyncedRowId("act_sy0123456789abcde")).toBe(true);
    expect(isSyncedRowId("hc_sy0123456789abcde")).toBe(true);
  });

  it("does not match ordinary or malformed ids", () => {
    expect(isSyncedRowId("con_abc123")).toBe(false);
    expect(isSyncedRowId("con_sy0123")).toBe(false);
    expect(isSyncedRowId("xyz_sy0123456789abcde")).toBe(false);
    expect(isSyncedRowId(undefined)).toBe(false);
  });
});

describe("rowIdOf", () => {
  it("falls back to hook_id", () => {
    expect(rowIdOf({ hook_id: "h_1" })).toBe("h_1");
    expect(rowIdOf({ id: "a", hook_id: "b" })).toBe("a");
    expect(rowIdOf(undefined)).toBeUndefined();
  });
});
