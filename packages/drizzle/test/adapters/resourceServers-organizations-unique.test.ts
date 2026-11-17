import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { getTestServer } from "../helpers/test-server";

const MIGRATION_TAG = "0020_resource_server_org_unique";

function statements(file: string): string[] {
  return fs
    .readFileSync(file, "utf-8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Applies every migration before `tag`, so rows can be seeded in the state a
// database is in just before the unique indexes are created.
function applyBefore(sqlite: Database.Database, tag: string) {
  const dir = path.join(__dirname, "../../drizzle");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    if (file.startsWith(tag)) return;
    for (const stmt of statements(path.join(dir, file))) sqlite.exec(stmt);
  }
}

function applyOne(sqlite: Database.Database, tag: string) {
  const dir = path.join(__dirname, "../../drizzle");
  const file = fs.readdirSync(dir).find((f) => f.startsWith(tag));
  if (!file) throw new Error(`migration ${tag} not found`);
  for (const stmt of statements(path.join(dir, file))) sqlite.exec(stmt);
}

async function setup() {
  const server = getTestServer();
  await server.data.tenants.create({ id: "t1", name: "Tenant 1" });
  await server.data.tenants.create({ id: "t2", name: "Tenant 2" });
  return server;
}

describe("resource_servers unique (tenant_id, identifier)", () => {
  it("rejects a duplicate identifier on create with a 409", async () => {
    const { data } = await setup();
    await data.resourceServers.create("t1", {
      name: "API",
      identifier: "https://api.example.com",
    });

    await expect(
      data.resourceServers.create("t1", {
        name: "API copy",
        identifier: "https://api.example.com",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("allows the same identifier in another tenant", async () => {
    const { data } = await setup();
    await data.resourceServers.create("t1", {
      name: "API",
      identifier: "https://api.example.com",
    });

    await expect(
      data.resourceServers.create("t2", {
        name: "API",
        identifier: "https://api.example.com",
      }),
    ).resolves.toMatchObject({ identifier: "https://api.example.com" });
  });

  it("rejects an update to an identifier another resource server uses", async () => {
    const { data } = await setup();
    await data.resourceServers.create("t1", {
      name: "A",
      identifier: "https://a.example.com",
    });
    const b = await data.resourceServers.create("t1", {
      name: "B",
      identifier: "https://b.example.com",
    });

    await expect(
      data.resourceServers.update("t1", b.id!, {
        identifier: "https://a.example.com",
      }),
    ).rejects.toMatchObject({ status: 409 });

    // An update that keeps its own identifier is not a conflict.
    await expect(
      data.resourceServers.update("t1", b.id!, {
        identifier: "https://b.example.com",
        name: "B2",
      }),
    ).resolves.toBe(true);
  });
});

describe("organizations unique (tenant_id, name)", () => {
  it("rejects a duplicate name on create with a 409", async () => {
    const { data } = await setup();
    await data.organizations.create("t1", { name: "acme" });

    await expect(
      data.organizations.create("t1", { name: "acme" }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("allows the same name in another tenant", async () => {
    const { data } = await setup();
    await data.organizations.create("t1", { name: "acme" });

    await expect(
      data.organizations.create("t2", { name: "acme" }),
    ).resolves.toMatchObject({ name: "acme" });
  });

  it("rejects an update to a name another organization uses", async () => {
    const { data } = await setup();
    await data.organizations.create("t1", { name: "acme" });
    const other = await data.organizations.create("t1", { name: "globex" });

    await expect(
      data.organizations.update("t1", other.id, { name: "acme" }),
    ).rejects.toMatchObject({ status: 409 });

    await expect(
      data.organizations.update("t1", other.id, {
        name: "globex",
        display_name: "Globex",
      }),
    ).resolves.toBe(true);
  });
});

describe(`migration ${MIGRATION_TAG}`, () => {
  it("creates both unique indexes", () => {
    const sqlite = new Database(":memory:");
    applyBefore(sqlite, MIGRATION_TAG);
    applyOne(sqlite, MIGRATION_TAG);

    const rows = sqlite
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?) ORDER BY name",
      )
      .all(
        "idx_organizations_tenant_name_unique",
        "resource_servers_tenant_identifier_uq",
      );
    expect(rows).toEqual([
      { name: "idx_organizations_tenant_name_unique" },
      { name: "resource_servers_tenant_identifier_uq" },
    ]);
  });

  // No dedupe step: existing duplicates have to be resolved by hand before
  // deploying, so the migration must fail loudly rather than drop rows.
  it("fails when a tenant already has duplicate organization names", () => {
    const sqlite = new Database(":memory:");
    applyBefore(sqlite, MIGRATION_TAG);
    const insert = sqlite.prepare(
      "INSERT INTO organizations (id, tenant_id, name, created_at, updated_at) VALUES (?, 't1', 'acme', '2026-01-01', '2026-01-01')",
    );
    insert.run("org_1");
    insert.run("org_2");

    expect(() => applyOne(sqlite, MIGRATION_TAG)).toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it("fails when a tenant already has duplicate resource-server identifiers", () => {
    const sqlite = new Database(":memory:");
    applyBefore(sqlite, MIGRATION_TAG);
    const insert = sqlite.prepare(
      "INSERT INTO resource_servers (id, tenant_id, identifier, name, created_at, updated_at) VALUES (?, 't1', 'https://api.example.com', 'API', '2026-01-01', '2026-01-01')",
    );
    insert.run("api_1");
    insert.run("api_2");

    expect(() => applyOne(sqlite, MIGRATION_TAG)).toThrow(
      /UNIQUE constraint failed/,
    );
  });
});
