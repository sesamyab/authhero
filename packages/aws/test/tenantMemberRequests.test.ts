import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { createTenantMemberRequestsAdapter } from "../src/adapters/tenantMemberRequests";

function setup() {
  const send = vi.fn();
  const adapter = createTenantMemberRequestsAdapter({
    client: { send } as unknown as DynamoDBDocumentClient,
    tableName: "test",
  });
  return { send, adapter };
}

const item = (id: string, extra: Record<string, unknown> = {}) => ({
  PK: "TENANT#tenant#MEMBER_REQUESTS",
  SK: `REQUEST#${id}`,
  id,
  tenant_id: "tenant",
  kind: "invite",
  status: "pending",
  requested_by: "auth0|admin",
  payload: { email: "new@example.com" },
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...extra,
});

afterEach(() => vi.restoreAllMocks());

describe("DynamoDB tenant member request commands", () => {
  it("creates a pending request under the tenant's partition", async () => {
    const { send, adapter } = setup();
    send.mockResolvedValue({});

    const created = await adapter.create("tenant", {
      kind: "invite",
      requested_by: "auth0|admin",
      payload: { email: "new@example.com" },
    });

    const command = send.mock.calls[0]![0] as PutCommand;
    expect(command).toBeInstanceOf(PutCommand);
    expect(command.input.Item).toMatchObject({
      PK: "TENANT#tenant#MEMBER_REQUESTS",
      SK: `REQUEST#${created.id}`,
      status: "pending",
    });
    expect(command.input.ConditionExpression).toBe("attribute_not_exists(PK)");
    expect(created).toMatchObject({ status: "pending", tenant_id: "tenant" });
  });

  it("reads one request with a consistent read, or null", async () => {
    const { send, adapter } = setup();
    send.mockResolvedValueOnce({ Item: item("tmr_1") });
    send.mockResolvedValueOnce({});

    expect(await adapter.get("tenant", "tmr_1")).toMatchObject({
      id: "tmr_1",
    });
    expect(await adapter.get("tenant", "tmr_2")).toBeNull();
    const command = send.mock.calls[0]![0] as GetCommand;
    expect(command.input.ConsistentRead).toBe(true);
  });

  it("lists newest first across pages of the query, with filters", async () => {
    const { send, adapter } = setup();
    send
      .mockResolvedValueOnce({
        Items: [
          item("tmr_1", { created_at: "2026-01-01T00:00:00.000Z" }),
          item("tmr_2", {
            created_at: "2026-01-02T00:00:00.000Z",
            status: "failed",
            notified_at: "2026-01-02T00:00:01.000Z",
          }),
        ],
        LastEvaluatedKey: { PK: "x", SK: "y" },
      })
      .mockResolvedValueOnce({
        Items: [item("tmr_3", { created_at: "2026-01-03T00:00:00.000Z" })],
      });

    const all = await adapter.list("tenant");
    expect(all.requests.map((r) => r.id)).toEqual(["tmr_3", "tmr_2", "tmr_1"]);
    expect(send.mock.calls[0]![0]).toBeInstanceOf(QueryCommand);

    send.mockResolvedValue({
      Items: [
        item("tmr_1"),
        item("tmr_2", { notified_at: "n", status: "failed" }),
      ],
    });
    expect(
      (await adapter.list("tenant", { status: "failed" })).requests.map(
        (r) => r.id,
      ),
    ).toEqual(["tmr_2"]);
    expect(
      (await adapter.list("tenant", { unnotified: true })).requests.map(
        (r) => r.id,
      ),
    ).toEqual(["tmr_1"]);
  });

  it("only updates a request that still has the expected status", async () => {
    const { send, adapter } = setup();
    send.mockResolvedValueOnce({});
    const conflict = new Error("conflict");
    conflict.name = "ConditionalCheckFailedException";
    send.mockRejectedValueOnce(conflict);

    expect(
      await adapter.update(
        "tenant",
        "tmr_1",
        { status: "succeeded" },
        "pending",
      ),
    ).toBe(true);
    expect(
      await adapter.update("tenant", "tmr_1", { status: "failed" }, "pending"),
    ).toBe(false);

    const command = send.mock.calls[0]![0] as UpdateCommand;
    expect(command.input.ConditionExpression).toContain("#status = :expected");
    expect(command.input.ExpressionAttributeValues).toMatchObject({
      ":expected": "pending",
    });
  });

  it("gives a finished request a TTL and rethrows other errors", async () => {
    const { send, adapter } = setup();
    send.mockResolvedValueOnce({});
    send.mockRejectedValueOnce(new Error("throttled"));

    await adapter.update("tenant", "tmr_1", {
      status: "succeeded",
      finished_at: "2026-01-01T00:00:00.000Z",
    });
    const values = (send.mock.calls[0]![0] as UpdateCommand).input
      .ExpressionAttributeValues!;
    expect(Object.values(values)).toContain(
      Math.floor(Date.parse("2026-01-01T00:00:00.000Z") / 1000) +
        90 * 24 * 60 * 60,
    );

    await expect(
      adapter.update("tenant", "tmr_1", { status: "failed" }),
    ).rejects.toThrow("throttled");
  });

  it("stamps finished_at and a TTL when a request ends without a time, and skips a bad one", async () => {
    const { send, adapter } = setup();
    send.mockResolvedValue({});

    await adapter.update("tenant", "tmr_1", { status: "succeeded" });
    const stamped = (send.mock.calls[0]![0] as UpdateCommand).input
      .ExpressionAttributeNames!;
    expect(Object.values(stamped)).toEqual(
      expect.arrayContaining(["finished_at", "ttl"]),
    );

    await adapter.update("tenant", "tmr_1", {
      status: "failed",
      finished_at: "not a date",
    });
    const bad = (send.mock.calls[1]![0] as UpdateCommand).input
      .ExpressionAttributeNames!;
    expect(Object.values(bad)).not.toContain("ttl");
  });
});
