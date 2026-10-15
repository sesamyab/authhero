import { and, eq } from "drizzle-orm";
import type {
  OrganizationConnection,
  OrganizationConnectionInsert,
  OrganizationConnectionsAdapter,
} from "@authhero/adapter-interfaces";
import { connections, organizationConnections } from "../schema/sqlite";
import type { DrizzleDb } from "./types";

type Row = typeof organizationConnections.$inferSelect;

function toDomain(
  row: Row,
  connection?: { name: string; strategy?: string },
): OrganizationConnection {
  return {
    connection_id: row.connection_id,
    assign_membership_on_login: Boolean(row.assign_membership_on_login),
    show_as_button: Boolean(row.show_as_button),
    is_signup_enabled: Boolean(row.is_signup_enabled),
    connection: connection
      ? { name: connection.name, strategy: connection.strategy }
      : undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function createOrganizationConnectionsAdapter(
  db: DrizzleDb,
): OrganizationConnectionsAdapter {
  async function loadConnection(tenantId: string, connectionId: string) {
    const conn = await db
      .select({ name: connections.name, strategy: connections.strategy })
      .from(connections)
      .where(
        and(
          eq(connections.tenant_id, tenantId),
          eq(connections.id, connectionId),
        ),
      )
      .get();
    if (!conn) return undefined;
    return {
      name: conn.name,
      strategy: typeof conn.strategy === "string" ? conn.strategy : undefined,
    };
  }

  const scope = (tenantId: string, orgId: string, connectionId: string) =>
    and(
      eq(organizationConnections.tenant_id, tenantId),
      eq(organizationConnections.organization_id, orgId),
      eq(organizationConnections.connection_id, connectionId),
    );

  return {
    async create(
      tenantId: string,
      organizationId: string,
      params: OrganizationConnectionInsert,
      options,
    ) {
      const importMetadata = options?.importMetadata;
      const now = new Date().toISOString();
      const row: Row = {
        tenant_id: tenantId,
        organization_id: organizationId,
        connection_id: params.connection_id,
        assign_membership_on_login: params.assign_membership_on_login ? 1 : 0,
        show_as_button: params.show_as_button === false ? 0 : 1,
        is_signup_enabled: params.is_signup_enabled === false ? 0 : 1,
        created_at: importMetadata?.created_at ?? now,
        updated_at: importMetadata?.updated_at ?? now,
      };
      await db.insert(organizationConnections).values(row);
      return toDomain(
        row,
        await loadConnection(tenantId, params.connection_id),
      );
    },

    async list(tenantId: string, organizationId: string) {
      const rows = await db
        .select()
        .from(organizationConnections)
        .where(
          and(
            eq(organizationConnections.tenant_id, tenantId),
            eq(organizationConnections.organization_id, organizationId),
          ),
        )
        .all();
      const out: OrganizationConnection[] = [];
      for (const row of rows) {
        out.push(
          toDomain(row, await loadConnection(tenantId, row.connection_id)),
        );
      }
      return out;
    },

    async get(tenantId: string, organizationId: string, connectionId: string) {
      const row = await db
        .select()
        .from(organizationConnections)
        .where(scope(tenantId, organizationId, connectionId))
        .get();
      if (!row) return null;
      return toDomain(row, await loadConnection(tenantId, connectionId));
    },

    async update(
      tenantId: string,
      organizationId: string,
      connectionId: string,
      params,
    ) {
      const patch: Partial<Row> = { updated_at: new Date().toISOString() };
      if (params.assign_membership_on_login !== undefined) {
        patch.assign_membership_on_login = params.assign_membership_on_login
          ? 1
          : 0;
      }
      if (params.show_as_button !== undefined) {
        patch.show_as_button = params.show_as_button ? 1 : 0;
      }
      if (params.is_signup_enabled !== undefined) {
        patch.is_signup_enabled = params.is_signup_enabled ? 1 : 0;
      }
      const updated = await db
        .update(organizationConnections)
        .set(patch)
        .where(scope(tenantId, organizationId, connectionId))
        .returning();
      if (updated.length === 0) return null;
      return toDomain(
        updated[0]!,
        await loadConnection(tenantId, connectionId),
      );
    },

    async remove(
      tenantId: string,
      organizationId: string,
      connectionId: string,
    ) {
      const deleted = await db
        .delete(organizationConnections)
        .where(scope(tenantId, organizationId, connectionId))
        .returning({ id: organizationConnections.connection_id });
      return deleted.length > 0;
    },
  };
}
