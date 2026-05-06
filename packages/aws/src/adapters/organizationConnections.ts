import {
  OrganizationConnection,
  OrganizationConnectionInsert,
  OrganizationConnectionsAdapter,
} from "@authhero/adapter-interfaces";
import { DynamoDBContext, DynamoDBBaseItem } from "../types";
import { organizationConnectionKeys, connectionKeys } from "../keys";
import {
  getItem,
  putItem,
  deleteItem,
  queryItems,
  updateItem,
} from "../utils";

interface OrganizationConnectionItem extends DynamoDBBaseItem {
  tenant_id: string;
  organization_id: string;
  connection_id: string;
  assign_membership_on_login: boolean;
  show_as_button: boolean;
  is_signup_enabled: boolean;
}

interface ConnectionItem extends DynamoDBBaseItem {
  id: string;
  tenant_id: string;
  name: string;
  strategy?: string;
}

async function loadConnection(
  ctx: DynamoDBContext,
  tenantId: string,
  connectionId: string,
): Promise<{ name: string; strategy?: string } | undefined> {
  const conn = await getItem<ConnectionItem>(
    ctx,
    connectionKeys.pk(tenantId),
    connectionKeys.sk(connectionId),
  );
  if (!conn) return undefined;
  return { name: conn.name, strategy: conn.strategy };
}

function toDomain(
  item: OrganizationConnectionItem,
  connection?: { name: string; strategy?: string },
): OrganizationConnection {
  return {
    connection_id: item.connection_id,
    assign_membership_on_login: item.assign_membership_on_login,
    show_as_button: item.show_as_button,
    is_signup_enabled: item.is_signup_enabled,
    connection: connection
      ? { name: connection.name, strategy: connection.strategy }
      : undefined,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

export function createOrganizationConnectionsAdapter(
  ctx: DynamoDBContext,
): OrganizationConnectionsAdapter {
  return {
    async create(
      tenantId: string,
      organizationId: string,
      params: OrganizationConnectionInsert,
    ): Promise<OrganizationConnection> {
      const now = new Date().toISOString();
      const item: OrganizationConnectionItem = {
        PK: organizationConnectionKeys.pk(tenantId, organizationId),
        SK: organizationConnectionKeys.sk(params.connection_id),
        entityType: "ORGANIZATION_CONNECTION",
        tenant_id: tenantId,
        organization_id: organizationId,
        connection_id: params.connection_id,
        assign_membership_on_login: params.assign_membership_on_login ?? false,
        show_as_button: params.show_as_button ?? true,
        is_signup_enabled: params.is_signup_enabled ?? true,
        created_at: now,
        updated_at: now,
      };
      await putItem(ctx, item);
      const connection = await loadConnection(
        ctx,
        tenantId,
        params.connection_id,
      );
      return toDomain(item, connection);
    },

    async list(
      tenantId: string,
      organizationId: string,
    ): Promise<OrganizationConnection[]> {
      const { items } = await queryItems<OrganizationConnectionItem>(
        ctx,
        organizationConnectionKeys.pk(tenantId, organizationId),
        { skPrefix: organizationConnectionKeys.skPrefix() },
      );
      const out: OrganizationConnection[] = [];
      for (const item of items) {
        const connection = await loadConnection(
          ctx,
          tenantId,
          item.connection_id,
        );
        out.push(toDomain(item, connection));
      }
      return out;
    },

    async get(
      tenantId: string,
      organizationId: string,
      connectionId: string,
    ): Promise<OrganizationConnection | null> {
      const item = await getItem<OrganizationConnectionItem>(
        ctx,
        organizationConnectionKeys.pk(tenantId, organizationId),
        organizationConnectionKeys.sk(connectionId),
      );
      if (!item) return null;
      const connection = await loadConnection(ctx, tenantId, connectionId);
      return toDomain(item, connection);
    },

    async update(
      tenantId: string,
      organizationId: string,
      connectionId: string,
      params,
    ): Promise<OrganizationConnection | null> {
      const existing = await getItem<OrganizationConnectionItem>(
        ctx,
        organizationConnectionKeys.pk(tenantId, organizationId),
        organizationConnectionKeys.sk(connectionId),
      );
      if (!existing) return null;
      const updates: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      if (params.assign_membership_on_login !== undefined) {
        updates.assign_membership_on_login = params.assign_membership_on_login;
      }
      if (params.show_as_button !== undefined) {
        updates.show_as_button = params.show_as_button;
      }
      if (params.is_signup_enabled !== undefined) {
        updates.is_signup_enabled = params.is_signup_enabled;
      }
      await updateItem(
        ctx,
        organizationConnectionKeys.pk(tenantId, organizationId),
        organizationConnectionKeys.sk(connectionId),
        updates,
      );
      const refreshed = await getItem<OrganizationConnectionItem>(
        ctx,
        organizationConnectionKeys.pk(tenantId, organizationId),
        organizationConnectionKeys.sk(connectionId),
      );
      if (!refreshed) return null;
      const connection = await loadConnection(ctx, tenantId, connectionId);
      return toDomain(refreshed, connection);
    },

    async remove(
      tenantId: string,
      organizationId: string,
      connectionId: string,
    ): Promise<boolean> {
      const existing = await getItem<OrganizationConnectionItem>(
        ctx,
        organizationConnectionKeys.pk(tenantId, organizationId),
        organizationConnectionKeys.sk(connectionId),
      );
      if (!existing) return false;
      return deleteItem(
        ctx,
        organizationConnectionKeys.pk(tenantId, organizationId),
        organizationConnectionKeys.sk(connectionId),
      );
    },
  };
}
