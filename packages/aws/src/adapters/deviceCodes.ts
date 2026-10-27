import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  deviceCodeSchema,
  type DeviceCodesAdapter,
} from "@authhero/adapter-interfaces";
import type { DynamoDBContext } from "../types";

export function createDeviceCodesAdapter(
  ctx: DynamoDBContext,
): DeviceCodesAdapter {
  const pk = (tenantId: string) => `TENANT#${tenantId}#DEVICE_FLOW`;
  const get = async (tenantId: string, sk: string) => {
    const result = await ctx.client.send(
      new GetCommand({
        TableName: ctx.tableName,
        Key: { PK: pk(tenantId), SK: sk },
        ConsistentRead: true,
      }),
    );
    return result.Item;
  };
  return {
    async create(tenantId, code) {
      const ttl = Math.floor(Date.parse(code.expires_at) / 1000);
      // The lookup row reserves the user code for this tenant. A transaction
      // prevents a collision from overwriting another pending device request.
      await ctx.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: ctx.tableName,
                Item: {
                  ...code,
                  PK: pk(tenantId),
                  SK: `CODE#${code.device_code_hash}`,
                  ttl,
                },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              Put: {
                TableName: ctx.tableName,
                Item: {
                  PK: pk(tenantId),
                  SK: `USER#${code.user_code_hash}`,
                  device_code_hash: code.device_code_hash,
                  ttl,
                },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
          ],
        }),
      );
    },
    async get(tenantId, hash) {
      const row = await get(tenantId, `CODE#${hash}`);
      return row ? deviceCodeSchema.parse(row) : null;
    },
    async getByUserCode(tenantId, hash) {
      const lookup = await get(tenantId, `USER#${hash}`);
      if (!lookup) return null;
      const row = await get(tenantId, `CODE#${lookup.device_code_hash}`);
      return row ? deviceCodeSchema.parse(row) : null;
    },
    async update(tenantId, hash, version, patch) {
      const entries = Object.entries({ ...patch, version: version + 1 });
      try {
        await ctx.client.send(
          new UpdateCommand({
            TableName: ctx.tableName,
            Key: { PK: pk(tenantId), SK: `CODE#${hash}` },
            UpdateExpression: `SET ${entries.map((_, i) => `#f${i} = :v${i}`).join(", ")}`,
            ConditionExpression: "#version = :expected",
            ExpressionAttributeNames: {
              "#version": "version",
              ...Object.fromEntries(entries.map(([key], i) => [`#f${i}`, key])),
            },
            ExpressionAttributeValues: {
              ":expected": version,
              ...Object.fromEntries(
                entries.map(([, value], i) => [`:v${i}`, value]),
              ),
            },
          }),
        );
        return true;
      } catch (error) {
        if (
          error instanceof Error &&
          error.name === "ConditionalCheckFailedException"
        )
          return false;
        throw error;
      }
    },
    async incrementAttempts(tenantId, key, expiresAt) {
      const result = await ctx.client.send(
        new UpdateCommand({
          TableName: ctx.tableName,
          Key: { PK: pk(tenantId), SK: `LIMIT#${key}` },
          UpdateExpression: "SET #ttl = :ttl ADD #attempts :one",
          ExpressionAttributeNames: { "#ttl": "ttl", "#attempts": "attempts" },
          ExpressionAttributeValues: {
            ":ttl": Math.floor(Date.parse(expiresAt) / 1000),
            ":one": 1,
          },
          ReturnValues: "UPDATED_NEW",
        }),
      );
      return result.Attributes!.attempts as number;
    },
    async cleanup() {
      return 0;
    }, // All three item types expire through DynamoDB TTL.
  };
}
