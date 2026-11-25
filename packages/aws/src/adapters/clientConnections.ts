import {
  ClientConnectionsAdapter,
  Connection,
} from "@authhero/adapter-interfaces";
import { DynamoDBContext, DynamoDBBaseItem } from "../types";
import { clientConnectionKeys } from "../keys";
import { putItem, deleteItem, queryItems } from "../utils";
import { BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createConnectionsAdapter } from "./connections";

interface ClientConnectionItem extends DynamoDBBaseItem {
  tenant_id: string;
  client_id: string;
  connection_id: string;
  order: number;
}

export function createClientConnectionsAdapter(
  ctx: DynamoDBContext,
): ClientConnectionsAdapter {
  const connectionAdapter = createConnectionsAdapter(ctx);
  return {
    async listByClient(
      tenantId: string,
      clientId: string,
    ): Promise<Connection[]> {
      const { items } = await queryItems<ClientConnectionItem>(
        ctx,
        clientConnectionKeys.pk(tenantId, clientId),
        { skPrefix: clientConnectionKeys.skPrefix() },
      );

      // Sort by order
      items.sort((a, b) => a.order - b.order);

      // Fetch the actual connection details
      const connections: Connection[] = [];
      for (const clientConnection of items) {
        const connection = await connectionAdapter.get(
          tenantId,
          clientConnection.connection_id,
        );
        if (connection) {
          connections.push(connection);
        }
      }

      return connections;
    },

    async updateByClient(
      tenantId: string,
      clientId: string,
      connectionIds: string[],
    ): Promise<boolean> {
      // First, delete all existing client connections
      const { items: existingItems } = await queryItems<ClientConnectionItem>(
        ctx,
        clientConnectionKeys.pk(tenantId, clientId),
        { skPrefix: clientConnectionKeys.skPrefix() },
      );

      // Delete existing items in batches
      if (existingItems.length > 0) {
        const deleteRequests = existingItems.map((item) => ({
          DeleteRequest: {
            Key: {
              PK: clientConnectionKeys.pk(tenantId, clientId),
              SK: clientConnectionKeys.sk(item.connection_id, item.order),
            },
          },
        }));

        // DynamoDB batch write limit is 25 items
        for (let i = 0; i < deleteRequests.length; i += 25) {
          const batch = deleteRequests.slice(i, i + 25);
          await ctx.client.send(
            new BatchWriteCommand({
              RequestItems: {
                [ctx.tableName]: batch,
              },
            }),
          );
        }
      }

      // Create new client connections
      const now = new Date().toISOString();
      for (let i = 0; i < connectionIds.length; i++) {
        const connectionId = connectionIds[i]!;
        const item: ClientConnectionItem = {
          PK: clientConnectionKeys.pk(tenantId, clientId),
          SK: clientConnectionKeys.sk(connectionId, i),
          GSI1PK: clientConnectionKeys.gsi1pk(tenantId, connectionId),
          GSI1SK: clientConnectionKeys.gsi1sk(clientId),
          entityType: "CLIENT_CONNECTION",
          tenant_id: tenantId,
          client_id: clientId,
          connection_id: connectionId,
          order: i,
          created_at: now,
          updated_at: now,
        };

        await putItem(ctx, item);
      }

      return true;
    },

    async listByConnection(
      tenantId: string,
      connectionId: string,
    ): Promise<string[]> {
      const { items } = await queryItems<ClientConnectionItem>(
        ctx,
        clientConnectionKeys.gsi1pk(tenantId, connectionId),
        {
          indexName: "GSI1",
          skPrefix: "CLIENT_CONNECTION#",
        },
      );

      return items.map((item) => item.client_id);
    },

    async addClientToConnection(
      tenantId: string,
      connectionId: string,
      clientId: string,
    ): Promise<boolean> {
      // Get current connections for the client
      const { items } = await queryItems<ClientConnectionItem>(
        ctx,
        clientConnectionKeys.pk(tenantId, clientId),
        { skPrefix: clientConnectionKeys.skPrefix() },
      );

      // Check if already exists
      if (items.some((item) => item.connection_id === connectionId)) {
        return true;
      }

      // Add the new connection at the end
      const order = items.length;
      const now = new Date().toISOString();

      const item: ClientConnectionItem = {
        PK: clientConnectionKeys.pk(tenantId, clientId),
        SK: clientConnectionKeys.sk(connectionId, order),
        GSI1PK: clientConnectionKeys.gsi1pk(tenantId, connectionId),
        GSI1SK: clientConnectionKeys.gsi1sk(clientId),
        entityType: "CLIENT_CONNECTION",
        tenant_id: tenantId,
        client_id: clientId,
        connection_id: connectionId,
        order,
        created_at: now,
        updated_at: now,
      };

      await putItem(ctx, item);

      return true;
    },

    async removeClientFromConnection(
      tenantId: string,
      connectionId: string,
      clientId: string,
    ): Promise<boolean> {
      // Find the specific connection
      const { items } = await queryItems<ClientConnectionItem>(
        ctx,
        clientConnectionKeys.pk(tenantId, clientId),
        { skPrefix: clientConnectionKeys.skPrefix() },
      );

      const item = items.find((i) => i.connection_id === connectionId);
      if (!item) {
        return false;
      }

      return deleteItem(
        ctx,
        clientConnectionKeys.pk(tenantId, clientId),
        clientConnectionKeys.sk(connectionId, item.order),
      );
    },
  };
}
