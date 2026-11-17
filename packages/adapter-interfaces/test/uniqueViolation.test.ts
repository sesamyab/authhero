import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "../src";

describe("isUniqueViolation", () => {
  it.each([
    ["better-sqlite3 code", { code: "SQLITE_CONSTRAINT_UNIQUE" }],
    ["sqlite primary key", { code: "SQLITE_CONSTRAINT_PRIMARYKEY" }],
    ["mysql2 code", { code: "ER_DUP_ENTRY" }],
    ["mysql errno", { errno: 1062 }],
    [
      "D1 message",
      new Error(
        "D1_ERROR: UNIQUE constraint failed: organizations.tenant_id, organizations.name: SQLITE_CONSTRAINT",
      ),
    ],
    [
      "PlanetScale message",
      new Error(
        "target: x.-.primary: vttablet: Duplicate entry (errno 1062) AlreadyExists",
      ),
    ],
    [
      "drizzle-wrapped cause",
      new Error("Failed query: insert into ...", {
        cause: new Error(
          "UNIQUE constraint failed: resource_servers.identifier",
        ),
      }),
    ],
  ])("detects %s", (_, err) => {
    expect(isUniqueViolation(err)).toBe(true);
  });

  it.each([
    ["undefined", undefined],
    ["string", "UNIQUE constraint failed"],
    ["other error", new Error("no such table: organizations")],
    ["foreign key", { code: "SQLITE_CONSTRAINT_FOREIGNKEY" }],
  ])("ignores %s", (_, err) => {
    expect(isUniqueViolation(err)).toBe(false);
  });

  it("ignores a query wrapper whose params match but whose cause does not", () => {
    // Shape of drizzle's DrizzleQueryError: the message carries the params.
    const wrapped = Object.assign(
      new Error(
        "Failed query: insert into resource_servers values (?, ?)\nparams: AlreadyExists,UNIQUE constraint failed",
        { cause: new Error("D1_ERROR: Network connection lost.") },
      ),
      {
        query: "insert into resource_servers values (?, ?)",
        params: ["AlreadyExists", "UNIQUE constraint failed"],
      },
    );
    expect(isUniqueViolation(wrapped)).toBe(false);

    // Same wrapper without the query/params fields is still recognized by
    // its message prefix.
    expect(
      isUniqueViolation(
        new Error("Failed query: insert ...\nparams: Duplicate entry", {
          cause: new Error("SQLITE_BUSY: database is locked"),
        }),
      ),
    ).toBe(false);
  });

  it("stops on a self-referencing cause", () => {
    const err: { message: string; cause?: unknown } = { message: "boom" };
    err.cause = err;
    expect(isUniqueViolation(err)).toBe(false);
  });
});
