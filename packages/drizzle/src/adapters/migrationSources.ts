import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  migrationProviderTypeSchema,
  type CreateOptions,
  type MigrationSource,
  type MigrationSourceCredentials,
  type MigrationSourceInsert,
  type MigrationSourcesAdapter,
} from "@authhero/adapter-interfaces";
import { migrationSources } from "../schema/sqlite";
import type { DrizzleDb } from "./types";

type Row = typeof migrationSources.$inferSelect;

function fromRow(row: Row): MigrationSource {
  return {
    id: row.id,
    name: row.name,
    provider: migrationProviderTypeSchema.parse(row.provider),
    connection: row.connection,
    enabled: row.enabled === 1,
    credentials: JSON.parse(row.credentials) as MigrationSourceCredentials,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createMigrationSourcesAdapter(
  db: DrizzleDb,
): MigrationSourcesAdapter {
  const scope = (tenant_id: string, id: string) =>
    and(eq(migrationSources.tenant_id, tenant_id), eq(migrationSources.id, id));

  return {
    async create(
      tenant_id: string,
      params: MigrationSourceInsert,
      options?: CreateOptions,
    ): Promise<MigrationSource> {
      const importMetadata = options?.importMetadata;
      const now = new Date().toISOString();
      const row: Row = {
        id: importMetadata?.id ?? params.id ?? `mig_${nanoid()}`,
        tenant_id,
        name: params.name,
        provider: params.provider,
        connection: params.connection,
        enabled: (params.enabled ?? true) ? 1 : 0,
        credentials: JSON.stringify(params.credentials),
        created_at: importMetadata?.created_at ?? now,
        updated_at: importMetadata?.updated_at ?? now,
      };
      await db.insert(migrationSources).values(row);
      return fromRow(row);
    },

    async get(tenant_id: string, id: string) {
      const row = await db
        .select()
        .from(migrationSources)
        .where(scope(tenant_id, id))
        .get();
      return row ? fromRow(row) : null;
    },

    async list(tenant_id: string) {
      const rows = await db
        .select()
        .from(migrationSources)
        .where(eq(migrationSources.tenant_id, tenant_id))
        .all();
      return rows.map(fromRow);
    },

    async update(tenant_id: string, id: string, params) {
      const patch: Partial<Row> = { updated_at: new Date().toISOString() };
      if (params.name !== undefined) patch.name = params.name;
      if (params.provider !== undefined) patch.provider = params.provider;
      if (params.connection !== undefined) patch.connection = params.connection;
      if (params.enabled !== undefined) patch.enabled = params.enabled ? 1 : 0;
      if (params.credentials !== undefined) {
        patch.credentials = JSON.stringify(params.credentials);
      }
      const updated = await db
        .update(migrationSources)
        .set(patch)
        .where(scope(tenant_id, id))
        .returning({ id: migrationSources.id });
      return updated.length > 0;
    },

    async remove(tenant_id: string, id: string) {
      const deleted = await db
        .delete(migrationSources)
        .where(scope(tenant_id, id))
        .returning({ id: migrationSources.id });
      return deleted.length > 0;
    },
  };
}
