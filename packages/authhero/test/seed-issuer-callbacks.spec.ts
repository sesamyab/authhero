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

describe("seed: default client follows the issuer", () => {
  it("allows the issuer's own admin callback, logout url and web origin", async () => {
    const data = await freshAdapters();
    await seed(data, { ...base, issuer: "https://acme.example.net/" });

    const client = await data.clients.get("acme", "default");
    expect(client?.callbacks).toContain(
      "https://acme.example.net/admin/auth-callback",
    );
    expect(client?.callbacks).toContain(
      "https://acme.example.net/auth-callback",
    );
    expect(client?.allowed_logout_urls).toContain("https://acme.example.net");
    expect(client?.allowed_logout_urls).toContain(
      "https://acme.example.net/admin",
    );
    expect(client?.web_origins).toEqual(["https://acme.example.net"]);
    // The fixed defaults are kept.
    expect(client?.callbacks).toContain(
      "http://localhost:3000/admin/auth-callback",
    );
  });

  it("leaves the defaults alone without an issuer", async () => {
    const data = await freshAdapters();
    await seed(data, base);

    const client = await data.clients.get("acme", "default");
    expect(client?.callbacks).not.toContain(
      "https://acme.example.net/admin/auth-callback",
    );
    expect(client?.web_origins ?? []).toEqual([]);
  });

  it("lets explicit callbacks win over the issuer", async () => {
    const data = await freshAdapters();
    await seed(data, {
      ...base,
      issuer: "https://acme.example.net/",
      callbacks: ["https://app.example.com/cb"],
      allowedLogoutUrls: ["https://app.example.com"],
    });

    const client = await data.clients.get("acme", "default");
    expect(client?.callbacks).toEqual(["https://app.example.com/cb"]);
    expect(client?.allowed_logout_urls).toEqual(["https://app.example.com"]);
  });
});
