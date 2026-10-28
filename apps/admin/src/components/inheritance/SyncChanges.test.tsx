import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SyncChanges, parseSyncResult } from "./SyncChanges";

afterEach(cleanup);

describe("parseSyncResult", () => {
  it("reads structured rows and error messages", () => {
    const parsed = parseSyncResult({
      status: "applied",
      dry_run: false,
      prune: true,
      rows: [{ entity: "action", key: "enrich", action: "added" }],
      error_messages: ["hook h_1: boom"],
    });

    expect(parsed).toMatchObject({
      status: "applied",
      prune: true,
      rows: [{ entity: "action", key: "enrich", action: "added" }],
      errors: ["hook h_1: boom"],
    });
  });

  it("falls back to the change strings of an older result", () => {
    const parsed = parseSyncResult({
      status: "dry-run",
      dry_run: true,
      changes: [
        "connection:google-oauth2:google",
        "skip action:enrich (the tenant has its own)",
        "delete hook:h_old",
      ],
    });

    expect(parsed?.rows).toEqual([
      { entity: "connection", key: "google-oauth2:google", action: "changed" },
      { entity: "action", key: "enrich", action: "skipped" },
      { entity: "hook", key: "h_old", action: "delete" },
    ]);
  });

  it("is null without a result, and ignores malformed rows", () => {
    expect(parseSyncResult(null)).toBeNull();
    expect(parseSyncResult({ rows: [{ nope: 1 }, "x"] })?.rows).toEqual([]);
  });
});

describe("SyncChanges", () => {
  it("groups a preview by entity and marks stale and kept rows", () => {
    render(
      <SyncChanges
        result={{
          status: "dry-run",
          dry_run: true,
          rows: [
            { entity: "connection", key: "google", action: "added" },
            { entity: "connection", key: "old", action: "delete" },
            { entity: "action", key: "enrich", action: "skipped" },
          ],
        }}
      />,
    );

    expect(screen.getAllByText("Connections")).toHaveLength(2);
    expect(screen.getByText("would add")).toBeTruthy();
    expect(screen.getByText("stale")).toBeTruthy();
    // Rows that stay as they are sit behind a toggle when there is more.
    expect(screen.queryByText("kept: tenant's own")).toBeNull();
    fireEvent.click(screen.getByText("Show 1 kept"));
    expect(screen.getByText("Actions")).toBeTruthy();
    expect(screen.getByText("kept: tenant's own")).toBeTruthy();
    expect(screen.getByText(/1 to add, 1 kept, 1 stale/)).toBeTruthy();
  });

  it("says removed once a sync with prune has run", () => {
    render(
      <SyncChanges
        result={{
          status: "applied",
          dry_run: false,
          prune: true,
          rows: [{ entity: "connection", key: "old", action: "delete" }],
        }}
      />,
    );

    expect(screen.getByText("removed")).toBeTruthy();
    expect(screen.queryByText("stale")).toBeNull();
  });

  it("shows the rows of a detach", () => {
    render(
      <SyncChanges
        result={{
          status: "dry-run",
          dry_run: true,
          rows: [
            { entity: "connection", key: "google", action: "converted" },
            { entity: "action", key: "platform", action: "kept" },
            { entity: "hook", key: "h_1", action: "removed" },
          ],
        }}
      />,
    );

    expect(screen.getByText("would convert")).toBeTruthy();
    expect(screen.getByText("would remove")).toBeTruthy();
    fireEvent.click(screen.getByText("Show 1 kept"));
    expect(screen.getByText("kept as copy")).toBeTruthy();
    expect(
      screen.getByText(/1 to convert, 1 to remove, 1 kept as copy/),
    ).toBeTruthy();
  });

  it("shows only the first rows of a long result until asked for all", () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({
      entity: "connection",
      key: `c${i}`,
      action: "added",
    }));
    render(<SyncChanges result={{ status: "applied", rows }} />);

    expect(screen.queryByText("c11")).toBeNull();
    fireEvent.click(screen.getByText("Show all 12"));
    expect(screen.getByText("c11")).toBeTruthy();
    fireEvent.click(screen.getByText("Show fewer"));
    expect(screen.queryByText("c11")).toBeNull();
  });

  it("shows every row when all of them are kept", () => {
    render(
      <SyncChanges
        result={{
          status: "dry-run",
          dry_run: true,
          rows: [{ entity: "action", key: "enrich", action: "skipped" }],
        }}
      />,
    );

    expect(screen.getByText("kept: tenant's own")).toBeTruthy();
    expect(screen.queryByText(/Show \d+ kept/)).toBeNull();
  });

  it("lists the errors, and says so when there is nothing to change", () => {
    const { rerender } = render(
      <SyncChanges
        result={{
          status: "applied",
          rows: [],
          error_messages: ["action enrich: boom"],
        }}
      />,
    );
    expect(screen.getByText("1 error")).toBeTruthy();
    expect(screen.getByText("action enrich: boom")).toBeTruthy();

    rerender(<SyncChanges result={{ status: "up-to-date", rows: [] }} />);
    expect(screen.getByText(/Already up to date/)).toBeTruthy();
  });
});
