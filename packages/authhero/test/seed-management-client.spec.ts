import { describe, expect, it } from "vitest";
import { Kysely, SqliteDialect } from "kysely";
import SQLite from "better-sqlite3";
import createAdapters, {
  Database,
  migrateToLatest,
} from "@authhero/kysely-adapter";
import { DataAdapters } from "@authhero/adapter-interfaces";
import { seed } from "../src/seed";

async function freshAdapters(): Promise<DataAdapters> {
  const sqlite = new SQLite(":memory:");
  const db = new Kysely<Database>({
    dialect: new SqliteDialect({ database: sqlite }),
  });
  await migrateToLatest(db, false);
  return createAdapters(db);
}

const base = {
  adminUsername: "admin",
  adminPassword: "Passw0rd!x",
  tenantId: "acme",
  tenantName: "Acme",
  isControlPlane: false,
  debug: false,
};

async function clientNames(data: DataAdapters) {
  const { clients } = await data.clients.list("acme");
  return clients.map((client) => client.name);
}

describe("seed: the management client", () => {
  it("creates the API Explorer Application by default", async () => {
    const data = await freshAdapters();
    await seed(data, base);

    expect(await clientNames(data)).toContain("API Explorer Application");
  });

  it("skips it with createManagementClient: false", async () => {
    const data = await freshAdapters();
    await seed(data, { ...base, createManagementClient: false });

    expect(await clientNames(data)).not.toContain("API Explorer Application");
  });
});
