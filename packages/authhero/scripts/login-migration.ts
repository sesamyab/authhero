#!/usr/bin/env npx tsx
/**
 * Move tenants from the classic login (/u) to the widget login (/u2).
 *
 * Connects with DATABASE_URL:
 *   - mysql://… or https://… → PlanetScale (kysely-planetscale)
 *   - anything else          → a SQLite file path (better-sqlite3)
 *
 * Usage:
 *   pnpm authhero login-migration count [--json]
 *   pnpm authhero login-migration check (--tenant <id> | --all) [--base-url <url>] [--json]
 *   pnpm authhero login-migration flip --tenant <id> [--dry-run]
 *   pnpm authhero login-migration rollback --tenant <id> [--dry-run]
 *
 * `flip` sets the tenant flag `flags.universal_login_version` to "2";
 * `rollback` removes it again. Client overrides are never changed, so a
 * rollback restores the earlier routing when the tenant had no flag or "1"
 * before; `flip` prints the previous value as `from`.
 */
import { Kysely, SqliteDialect } from "kysely";
import createAdapters, { Database } from "@authhero/kysely-adapter";
import {
  auditLoginMigration,
  checkWidgetServed,
  listAllClients,
  listAllTenants,
  resolveTenantClients,
  setTenantLoginVersion,
  LoginMigrationReport,
} from "../src/helpers/login-migration";

type Flags = Record<string, string | boolean>;

function parseArgs(argv: string[]): { command?: string; flags: Flags } {
  const [command, ...rest] = argv;
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
}

async function connect(): Promise<Kysely<Database>> {
  const url = process.env.DATABASE_URL;
  if (!url)
    throw new Error("Set DATABASE_URL (PlanetScale URL or SQLite path)");
  if (/^(mysql|https?):\/\//.test(url)) {
    const { PlanetScaleDialect } = await import("kysely-planetscale");
    return new Kysely<Database>({ dialect: new PlanetScaleDialect({ url }) });
  }
  const { default: SQLite } = await import("better-sqlite3");
  return new Kysely<Database>({
    dialect: new SqliteDialect({ database: new SQLite(url) }),
  });
}

const ICON = { ok: "✅", warn: "⚠️ ", info: "ℹ️ " } as const;

function printReport(report: LoginMigrationReport) {
  console.log(
    `\n## ${report.tenant_id} (tenant version ${report.tenant_version ?? "unset"}, ${report.unmigrated}/${report.clients.length} clients on /u)`,
  );
  for (const check of report.checks) {
    console.log(`${ICON[check.status]} ${check.message}`);
  }
}

function requireTenant(flags: Flags): string {
  if (typeof flags.tenant !== "string")
    throw new Error("--tenant <id> is required");
  return flags.tenant;
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const dryRun = flags["dry-run"] === true;
  const json = flags.json === true;
  const db = await connect();
  const data = createAdapters(db);

  try {
    switch (command) {
      case "count": {
        const rows: {
          tenant_id: string;
          tenant_version: string;
          total: number;
          on_u: number;
        }[] = [];
        for (const tenant of await listAllTenants(data)) {
          const clients = await listAllClients(data, tenant.id);
          const onU = resolveTenantClients(tenant, clients).filter(
            (c) => c.prefix === "/u",
          ).length;
          rows.push({
            tenant_id: tenant.id,
            tenant_version: tenant.flags?.universal_login_version ?? "unset",
            total: clients.length,
            on_u: onU,
          });
        }
        const totals = {
          tenants: rows.length,
          tenants_with_u: rows.filter((r) => r.on_u > 0).length,
          clients: rows.reduce((n, r) => n + r.total, 0),
          clients_on_u: rows.reduce((n, r) => n + r.on_u, 0),
        };
        if (json) {
          console.log(JSON.stringify({ totals, tenants: rows }, null, 2));
        } else {
          console.table(rows.filter((r) => r.on_u > 0));
          console.log(totals);
        }
        break;
      }
      case "check": {
        const tenantIds =
          flags.all === true
            ? (await listAllTenants(data)).map((t) => t.id)
            : [requireTenant(flags)];
        const reports: LoginMigrationReport[] = [];
        for (const tenantId of tenantIds) {
          const report = await auditLoginMigration(data, tenantId);
          if (typeof flags["base-url"] === "string") {
            report.checks.push(await checkWidgetServed(flags["base-url"]));
          }
          reports.push(report);
          if (!json) printReport(report);
        }
        if (json) console.log(JSON.stringify(reports, null, 2));
        break;
      }
      case "flip":
      case "rollback": {
        const result = await setTenantLoginVersion(
          data,
          requireTenant(flags),
          command === "flip" ? "2" : undefined,
          { dryRun },
        );
        console.log(JSON.stringify({ dryRun, ...result }, null, 2));
        if (command === "flip" && result.pinned.length > 0) {
          console.warn(
            `⚠️  ${result.pinned.length} client(s) stay on /u through a "1" override: ${result.pinned.join(", ")}`,
          );
        }
        break;
      }
      default:
        console.error(
          "Usage: login-migration <count|check|flip|rollback> [--tenant id] [--all] [--base-url url] [--dry-run] [--json]",
        );
        process.exitCode = 1;
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
