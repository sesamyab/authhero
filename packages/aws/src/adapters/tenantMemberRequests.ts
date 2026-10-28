import { nanoid } from "nanoid";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  tenantMemberRequestInsertSchema,
  tenantMemberRequestSchema,
  type ListTenantMemberRequestsParams,
  type ListTenantMemberRequestsResult,
  type TenantMemberRequest,
  type TenantMemberRequestInsert,
  type TenantMemberRequestUpdate,
  type TenantMemberRequestsAdapter,
} from "@authhero/adapter-interfaces";
import type { DynamoDBContext } from "../types";
import { removeNullProperties, stripDynamoDBFields } from "../utils";

/** How long a finished request stays before DynamoDB TTL removes it. */
const FINISHED_RETENTION_SECONDS = 90 * 24 * 60 * 60;

const isConditionFailure = (error: unknown) =>
  error instanceof Error && error.name === "ConditionalCheckFailedException";

export function createTenantMemberRequestsAdapter(
  ctx: DynamoDBContext,
): TenantMemberRequestsAdapter {
  const pk = (tenantId: string) => `TENANT#${tenantId}#MEMBER_REQUESTS`;
  const sk = (id: string) => `REQUEST#${id}`;
  const toRequest = (item: Record<string, unknown>): TenantMemberRequest =>
    tenantMemberRequestSchema.parse(
      removeNullProperties(stripDynamoDBFields(item)),
    );

  return {
    async create(tenantId: string, request: TenantMemberRequestInsert) {
      const input = tenantMemberRequestInsertSchema.parse(request);
      const now = new Date().toISOString();
      const created: TenantMemberRequest = {
        id: `tmr_${nanoid()}`,
        tenant_id: tenantId,
        kind: input.kind,
        status: "pending",
        requested_by: input.requested_by,
        payload: input.payload,
        created_at: now,
        updated_at: now,
      };
      await ctx.client.send(
        new PutCommand({
          TableName: ctx.tableName,
          Item: { ...created, PK: pk(tenantId), SK: sk(created.id) },
          ConditionExpression: "attribute_not_exists(PK)",
        }),
      );
      return created;
    },

    async get(tenantId: string, id: string) {
      const result = await ctx.client.send(
        new GetCommand({
          TableName: ctx.tableName,
          Key: { PK: pk(tenantId), SK: sk(id) },
          ConsistentRead: true,
        }),
      );
      return result.Item ? toRequest(result.Item) : null;
    },

    async list(
      tenantId: string,
      params: ListTenantMemberRequestsParams = {},
    ): Promise<ListTenantMemberRequestsResult> {
      const page = params.page ?? 0;
      const per_page = params.per_page ?? 50;
      const statuses =
        params.status === undefined
          ? undefined
          : Array.isArray(params.status)
            ? params.status
            : [params.status];

      // A tenant has few team-change requests, so read them all and filter and
      // order here rather than keeping an index per filter.
      const items: Record<string, unknown>[] = [];
      let startKey: Record<string, unknown> | undefined;
      do {
        const result = await ctx.client.send(
          new QueryCommand({
            TableName: ctx.tableName,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
            ExpressionAttributeValues: {
              ":pk": pk(tenantId),
              ":prefix": "REQUEST#",
            },
            ConsistentRead: true,
            ExclusiveStartKey: startKey,
          }),
        );
        items.push(...((result.Items as Record<string, unknown>[]) ?? []));
        startKey = result.LastEvaluatedKey;
      } while (startKey);

      const matching = items
        .map(toRequest)
        .filter((r) => !statuses || statuses.includes(r.status))
        .filter((r) => !params.unnotified || !r.notified_at)
        .filter(
          (r) => !params.created_before || r.created_at < params.created_before,
        )
        .sort(
          (a, b) =>
            b.created_at.localeCompare(a.created_at) ||
            b.id.localeCompare(a.id),
        );
      const requests = matching.slice(page * per_page, (page + 1) * per_page);

      return {
        requests,
        start: page * per_page,
        limit: per_page,
        length: requests.length,
      };
    },

    async update(
      tenantId: string,
      id: string,
      patch: TenantMemberRequestUpdate,
      expectedStatus?,
    ) {
      const updates: Record<string, unknown> = {
        ...patch,
        updated_at: new Date().toISOString(),
      };
      if (patch.finished_at) {
        updates.ttl =
          Math.floor(Date.parse(patch.finished_at) / 1000) +
          FINISHED_RETENTION_SECONDS;
      }
      const entries = Object.entries(updates).filter(
        ([, value]) => value !== undefined,
      );

      try {
        await ctx.client.send(
          new UpdateCommand({
            TableName: ctx.tableName,
            Key: { PK: pk(tenantId), SK: sk(id) },
            UpdateExpression: `SET ${entries.map((_, i) => `#f${i} = :v${i}`).join(", ")}`,
            ConditionExpression: expectedStatus
              ? "attribute_exists(PK) AND #status = :expected"
              : "attribute_exists(PK)",
            ExpressionAttributeNames: {
              ...(expectedStatus ? { "#status": "status" } : {}),
              ...Object.fromEntries(entries.map(([key], i) => [`#f${i}`, key])),
            },
            ExpressionAttributeValues: {
              ...(expectedStatus ? { ":expected": expectedStatus } : {}),
              ...Object.fromEntries(
                entries.map(([, value], i) => [`:v${i}`, value]),
              ),
            },
          }),
        );
        return true;
      } catch (error) {
        if (isConditionFailure(error)) return false;
        throw error;
      }
    },

    // Finished requests carry a `ttl`, so DynamoDB removes them.
    async cleanup() {
      return 0;
    },
  };
}
