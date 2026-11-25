import {
  ClientRegistrationTokensAdapter,
  ClientRegistrationToken,
  ClientRegistrationTokenInsert,
  ClientRegistrationTokenSource,
  ClientRegistrationTokenType,
  clientRegistrationTokenSchema,
} from "@authhero/adapter-interfaces";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { DynamoDBContext, DynamoDBBaseItem } from "../types";
import { clientRegistrationTokenKeys } from "../keys";
import {
  getItem,
  putItem,
  deleteItem,
  queryItems,
  stripDynamoDBFields,
  removeNullProperties,
} from "../utils";

interface ClientRegistrationTokenItem extends DynamoDBBaseItem {
  id: string;
  tenant_id: string;
  token_hash: string;
  type: ClientRegistrationTokenType;
  client_id?: string;
  sub?: string;
  constraints?: string; // JSON string
  single_use: boolean;
  expires_at?: string;
  used_at?: string;
  revoked_at?: string;
  name?: string;
  created_by?: string;
  source?: ClientRegistrationTokenSource;
}

function toToken(item: ClientRegistrationTokenItem): ClientRegistrationToken {
  const { tenant_id, constraints, ...rest } = stripDynamoDBFields(item);
  const data = removeNullProperties({
    ...rest,
    constraints: constraints ? JSON.parse(constraints) : undefined,
  });
  return clientRegistrationTokenSchema.parse(data);
}

export function createClientRegistrationTokensAdapter(
  ctx: DynamoDBContext,
): ClientRegistrationTokensAdapter {
  return {
    async create(
      tenantId: string,
      token: ClientRegistrationTokenInsert,
    ): Promise<ClientRegistrationToken> {
      const now = new Date().toISOString();

      const item: ClientRegistrationTokenItem = {
        PK: clientRegistrationTokenKeys.pk(tenantId),
        SK: clientRegistrationTokenKeys.sk(token.id),
        GSI1PK: clientRegistrationTokenKeys.gsi1pk(tenantId, token.token_hash),
        GSI1SK: clientRegistrationTokenKeys.gsi1sk(),
        entityType: "CLIENT_REGISTRATION_TOKEN",
        tenant_id: tenantId,
        id: token.id,
        token_hash: token.token_hash,
        type: token.type,
        client_id: token.client_id,
        sub: token.sub,
        constraints: token.constraints
          ? JSON.stringify(token.constraints)
          : undefined,
        single_use: token.single_use,
        expires_at: token.expires_at,
        name: token.name,
        created_by: token.created_by,
        source: token.source,
        created_at: now,
        updated_at: now,
      };

      if (token.client_id) {
        item.GSI2PK = clientRegistrationTokenKeys.gsi2pk(
          tenantId,
          token.client_id,
        );
        item.GSI2SK = clientRegistrationTokenKeys.gsi2sk(token.id);
      }

      if (token.expires_at) {
        item.ttl = Math.floor(new Date(token.expires_at).getTime() / 1000);
      }

      await putItem(ctx, item);

      return toToken(item);
    },

    async get(tenantId, id) {
      const item = await getItem<ClientRegistrationTokenItem>(
        ctx,
        clientRegistrationTokenKeys.pk(tenantId),
        clientRegistrationTokenKeys.sk(id),
      );
      return item ? toToken(item) : null;
    },

    async getByHash(tenantId, tokenHash) {
      const result = await queryItems<ClientRegistrationTokenItem>(
        ctx,
        clientRegistrationTokenKeys.gsi1pk(tenantId, tokenHash),
        {
          indexName: "GSI1",
          skValue: clientRegistrationTokenKeys.gsi1sk(),
          limit: 1,
        },
      );
      return result.items[0] ? toToken(result.items[0]) : null;
    },

    async list(tenantId, params = {}) {
      const page = params.page ?? 0;
      const per_page = params.per_page ?? 50;

      // Sort keys are not time-ordered and the filters are not indexed, so
      // read the tenant's tokens and filter in memory. Expired tokens are
      // removed by TTL, which keeps this set small.
      const items: ClientRegistrationTokenItem[] = [];
      let startKey: Record<string, unknown> | undefined;
      do {
        const result = await queryItems<ClientRegistrationTokenItem>(
          ctx,
          clientRegistrationTokenKeys.pk(tenantId),
          { skPrefix: clientRegistrationTokenKeys.skPrefix(), startKey },
        );
        items.push(...result.items);
        startKey = result.lastKey;
      } while (startKey);

      const tokens = items
        .map(toToken)
        .filter(
          (token) =>
            (!params.type || token.type === params.type) &&
            (!params.client_id || token.client_id === params.client_id) &&
            (!params.source || token.source === params.source),
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at));

      const pageTokens = tokens.slice(page * per_page, (page + 1) * per_page);
      return {
        client_registration_tokens: pageTokens,
        start: page * per_page,
        limit: per_page,
        length: pageTokens.length,
        ...(params.include_totals ? { total: tokens.length } : {}),
      };
    },

    async listByClient(tenantId, clientId) {
      const result = await queryItems<ClientRegistrationTokenItem>(
        ctx,
        clientRegistrationTokenKeys.gsi2pk(tenantId, clientId),
        {
          indexName: "GSI2",
          skPrefix: clientRegistrationTokenKeys.skPrefix(),
          scanIndexForward: false,
        },
      );
      return result.items.map(toToken);
    },

    async markUsed(tenantId, id, used_at, client_id) {
      // Recording the created client also indexes the token under it (GSI2),
      // so listByClient finds the invite that created the client.
      const clientSet = client_id
        ? ", #client_id = :client_id, #gsi2pk = :gsi2pk, #gsi2sk = :gsi2sk"
        : "";
      try {
        await ctx.client.send(
          new UpdateCommand({
            TableName: ctx.tableName,
            Key: {
              PK: clientRegistrationTokenKeys.pk(tenantId),
              SK: clientRegistrationTokenKeys.sk(id),
            },
            UpdateExpression: `SET #used_at = :used_at, #updated_at = :updated_at${clientSet}`,
            ConditionExpression:
              "attribute_exists(PK) AND attribute_not_exists(#used_at)",
            ExpressionAttributeNames: {
              "#used_at": "used_at",
              "#updated_at": "updated_at",
              ...(client_id
                ? {
                    "#client_id": "client_id",
                    "#gsi2pk": "GSI2PK",
                    "#gsi2sk": "GSI2SK",
                  }
                : {}),
            },
            ExpressionAttributeValues: {
              ":used_at": used_at,
              ":updated_at": new Date().toISOString(),
              ...(client_id
                ? {
                    ":client_id": client_id,
                    ":gsi2pk": clientRegistrationTokenKeys.gsi2pk(
                      tenantId,
                      client_id,
                    ),
                    ":gsi2sk": clientRegistrationTokenKeys.gsi2sk(id),
                  }
                : {}),
            },
          }),
        );
        return true;
      } catch (err: unknown) {
        if (
          (err as { name?: string })?.name === "ConditionalCheckFailedException"
        ) {
          return false;
        }
        throw err;
      }
    },

    async revoke(tenantId, id, revoked_at) {
      try {
        await ctx.client.send(
          new UpdateCommand({
            TableName: ctx.tableName,
            Key: {
              PK: clientRegistrationTokenKeys.pk(tenantId),
              SK: clientRegistrationTokenKeys.sk(id),
            },
            UpdateExpression:
              "SET #revoked_at = :revoked_at, #updated_at = :updated_at",
            ConditionExpression: "attribute_exists(PK)",
            ExpressionAttributeNames: {
              "#revoked_at": "revoked_at",
              "#updated_at": "updated_at",
            },
            ExpressionAttributeValues: {
              ":revoked_at": revoked_at,
              ":updated_at": new Date().toISOString(),
            },
          }),
        );
        return true;
      } catch (err: unknown) {
        if (
          (err as { name?: string })?.name === "ConditionalCheckFailedException"
        ) {
          return false;
        }
        throw err;
      }
    },

    async revokeByClient(tenantId, clientId, revoked_at) {
      const result = await queryItems<ClientRegistrationTokenItem>(
        ctx,
        clientRegistrationTokenKeys.gsi2pk(tenantId, clientId),
        {
          indexName: "GSI2",
          skPrefix: clientRegistrationTokenKeys.skPrefix(),
        },
      );

      let count = 0;
      const now = new Date().toISOString();
      for (const item of result.items) {
        if (item.revoked_at) continue;
        try {
          await ctx.client.send(
            new UpdateCommand({
              TableName: ctx.tableName,
              Key: { PK: item.PK, SK: item.SK },
              UpdateExpression:
                "SET #revoked_at = :revoked_at, #updated_at = :updated_at",
              ConditionExpression:
                "attribute_exists(PK) AND attribute_not_exists(#revoked_at)",
              ExpressionAttributeNames: {
                "#revoked_at": "revoked_at",
                "#updated_at": "updated_at",
              },
              ExpressionAttributeValues: {
                ":revoked_at": revoked_at,
                ":updated_at": now,
              },
            }),
          );
          count++;
        } catch (err: unknown) {
          if (
            (err as { name?: string })?.name ===
            "ConditionalCheckFailedException"
          ) {
            continue;
          }
          throw err;
        }
      }
      return count;
    },

    async remove(tenantId, id) {
      return deleteItem(
        ctx,
        clientRegistrationTokenKeys.pk(tenantId),
        clientRegistrationTokenKeys.sk(id),
      );
    },
  };
}
