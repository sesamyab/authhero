import { describe, expect, it } from "vitest";
import { Kysely, SqliteDialect, sql } from "kysely";
import SQLite from "better-sqlite3";
import {
  Database,
  formatMigrationPlan,
  migrateToLatest,
  planMigrations,
} from "../src";
import migrations from "../migrate/migrations";

function createDb() {
  return new Kysely<Database>({
    dialect: new SqliteDialect({ database: new SQLite(":memory:") }),
  });
}

async function tableNames(db: Kysely<Database>): Promise<string[]> {
  const { rows } = await sql<{
    name: string;
  }>`SELECT name FROM sqlite_master WHERE type = 'table'`.execute(db);
  return rows.map((row) => row.name);
}

async function columnNames(
  db: Kysely<Database>,
  table: string,
): Promise<string[]> {
  const { rows } = await sql<{
    name: string;
  }>`SELECT name FROM pragma_table_info(${table})`.execute(db);
  return rows.map((row) => row.name);
}

describe("planMigrations", () => {
  it("lists every migration on an empty database without writing anything", async () => {
    const db = createDb();

    const plan = await planMigrations(db);

    expect(plan.executed).toEqual([]);
    expect(plan.pending.map((it) => it.name)).toEqual(Object.keys(migrations));
    const baseline = plan.pending[0]!;
    expect(baseline.error).toBeUndefined();
    expect(
      baseline.statements.some((it) => /^create table "users"/.test(it.sql)),
    ).toBe(true);

    // Not even the kysely_migration bookkeeping tables.
    expect(await tableNames(db)).toEqual([]);
    await db.destroy();
  });

  it("reports nothing pending on a migrated database", async () => {
    const db = createDb();
    await migrateToLatest(db, false);

    const plan = await planMigrations(db);

    expect(plan.pending).toEqual([]);
    expect(plan.executed).toEqual(Object.keys(migrations));
    expect(formatMigrationPlan(plan)).toMatch(/up to date/);
    await db.destroy();
  });

  it("plans only the migrations that have not run", async () => {
    const db = createDb();
    await migrateToLatest(db, false);
    // The last two migrations are rolled back together: a pending migration
    // may not sort before an executed one.
    const pending = [
      "2026-11-20T12:00:00_self_service_sso",
      "2026-11-20T13:00:00_theme_dark",
    ] as const;
    for (const name of [...pending].reverse()) {
      await migrations[name].down(db);
      await sql`DELETE FROM kysely_migration WHERE name = ${name}`.execute(db);
    }

    const plan = await planMigrations(db);

    expect(plan.pending.map((it) => it.name)).toEqual([...pending]);
    expect(plan.pending.every((it) => it.error === undefined)).toBe(true);
    const output = formatMigrationPlan(plan);
    expect(output).toMatch(
      /alter table "themes" add column "colors_dark_primary_button"/i,
    );
    expect(await columnNames(db, "themes")).not.toContain(
      "colors_dark_primary_button",
    );
    for (const table of ["self_service_profiles", "sso_access_tickets"]) {
      expect(output).toMatch(
        new RegExp(`create table if not exists "${table}"`, "i"),
      );
      expect(await tableNames(db)).not.toContain(table);
    }
    expect(output).toMatch(
      /create unique index "sso_access_tickets_ticket_hash_idx"/i,
    );

    // The real run still applies them afterwards.
    await migrateToLatest(db, false);
    for (const table of ["self_service_profiles", "sso_access_tickets"]) {
      expect(await tableNames(db)).toContain(table);
    }
    expect(await columnNames(db, "themes")).toContain(
      "colors_dark_primary_button",
    );
    await db.destroy();
  });
});

describe("2026-11-20T12:00:00_self_service_sso", () => {
  it("can be re-run when its tables and indexes already exist", async () => {
    const db = createDb();
    await migrateToLatest(db, false);
    await expect(
      migrations["2026-11-20T12:00:00_self_service_sso"].up(db),
    ).resolves.toBeUndefined();
    await db.destroy();
  });
});

describe("2026-11-20T13:00:00_theme_dark", () => {
  it("adds the dark theme columns, and can be rolled back and re-run", async () => {
    const db = createDb();
    await migrateToLatest(db, false);
    const name = "2026-11-20T13:00:00_theme_dark";
    expect(await columnNames(db, "themes")).toContain(
      "colors_dark_primary_button",
    );
    expect(await columnNames(db, "branding")).toContain("favicon_url_dark");

    await migrations[name].down(db);
    expect(await columnNames(db, "themes")).not.toContain(
      "colors_dark_primary_button",
    );
    expect(await columnNames(db, "branding")).not.toContain("favicon_url_dark");

    await migrations[name].up(db);
    // Re-running on an up-to-date schema is a no-op.
    await expect(migrations[name].up(db)).resolves.toBeUndefined();
    expect(await columnNames(db, "themes")).toContain(
      "colors_dark_primary_button",
    );
    await db.destroy();
  });
});
