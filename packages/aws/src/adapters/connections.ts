import { nanoid } from "nanoid";
import {
  ConnectionsAdapter,
  Connection,
  ConnectionInsert,
  ConnectionInternalFields,
  ListConnectionsResponse,
  ListParams,
  connectionSchema,
} from "@authhero/adapter-interfaces";
import { DynamoDBContext, DynamoDBBaseItem } from "../types";
import { connectionKeys } from "../keys";
import {
  getItem,
  putItem,
  deleteItem,
  queryWithPagination,
  updateItem,
  stripDynamoDBFields,
  removeNullProperties,
} from "../utils";

interface ConnectionItem extends DynamoDBBaseItem {
  id: string;
  tenant_id: string;
  name: string;
  strategy: string;
  options?: string; // JSON string
  is_system?: boolean;
  scope?: ConnectionInsert["scope"];
  override?: ConnectionInsert["override"];
  enforce?: boolean;
  self_service?: string | null; // JSON string (`ConnectionSelfService`)
}

/** `null` clears the attribute; an object is stored as JSON. */
function selfServiceToItem(
  value: ConnectionInternalFields["self_service"],
): string | null | undefined {
  if (value === undefined) return undefined;
  return value === null ? null : JSON.stringify(value);
}

function toConnection(item: ConnectionItem): Connection {
  const { tenant_id, is_system, self_service, ...rest } =
    stripDynamoDBFields(item);

  const data = removeNullProperties({
    ...rest,
    options: item.options ? JSON.parse(item.options) : undefined,
    is_system: is_system ? true : undefined,
  });

  // `self_service` is internal and not part of `connectionSchema`, so it is
  // attached after parsing (the parse would strip it).
  const connection: Connection = connectionSchema.parse(data);
  if (typeof self_service === "string" && self_service) {
    connection.self_service = JSON.parse(self_service);
  }
  return connection;
}

export function createConnectionsAdapter(
  ctx: DynamoDBContext,
): ConnectionsAdapter {
  return {
    async create(
      tenantId: string,
      params: ConnectionInsert & ConnectionInternalFields,
    ): Promise<Connection> {
      const now = new Date().toISOString();
      const id = params.id || nanoid();

      const item: ConnectionItem = {
        PK: connectionKeys.pk(tenantId),
        SK: connectionKeys.sk(id),
        GSI1PK: connectionKeys.gsi1pk(tenantId, params.name),
        GSI1SK: connectionKeys.gsi1sk(),
        entityType: "CONNECTION",
        tenant_id: tenantId,
        id,
        name: params.name,
        strategy: params.strategy,
        options: params.options ? JSON.stringify(params.options) : undefined,
        is_system: params.is_system ?? false,
        scope: params.scope,
        override: params.override,
        enforce: params.enforce,
        self_service: selfServiceToItem(params.self_service),
        created_at: now,
        updated_at: now,
      };

      await putItem(ctx, item);

      return toConnection(item);
    },

    async get(
      tenantId: string,
      connectionId: string,
    ): Promise<Connection | null> {
      const item = await getItem<ConnectionItem>(
        ctx,
        connectionKeys.pk(tenantId),
        connectionKeys.sk(connectionId),
      );

      if (!item) return null;

      return toConnection(item);
    },

    async list(
      tenantId: string,
      params: ListParams = {},
    ): Promise<ListConnectionsResponse> {
      const result = await queryWithPagination<ConnectionItem>(
        ctx,
        connectionKeys.pk(tenantId),
        params,
        { skPrefix: "CONNECTION#" },
      );

      return {
        connections: result.items.map(toConnection),
        start: result.start,
        limit: result.limit,
        length: result.length,
        next: result.next,
      };
    },

    async update(
      tenantId: string,
      connectionId: string,
      params: Partial<ConnectionInsert> & ConnectionInternalFields,
    ): Promise<boolean> {
      const updates: Record<string, unknown> = {
        ...params,
        self_service: selfServiceToItem(params.self_service),
        updated_at: new Date().toISOString(),
      };

      if (params.options !== undefined) {
        updates.options = JSON.stringify(params.options);
      }

      // Update GSI1 keys if name changes
      if (params.name !== undefined) {
        updates.GSI1PK = connectionKeys.gsi1pk(tenantId, params.name);
        updates.GSI1SK = connectionKeys.gsi1sk();
      }

      // Remove id from updates
      delete updates.id;

      return updateItem(
        ctx,
        connectionKeys.pk(tenantId),
        connectionKeys.sk(connectionId),
        updates,
      );
    },

    async remove(tenantId: string, connectionId: string): Promise<boolean> {
      return deleteItem(
        ctx,
        connectionKeys.pk(tenantId),
        connectionKeys.sk(connectionId),
      );
    },
  };
}
