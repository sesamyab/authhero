import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { createDeviceCodesAdapter } from "../src/adapters/deviceCodes";
import type { DeviceCode } from "@authhero/adapter-interfaces";

const code: DeviceCode = {
  device_code_hash: "device-hash",
  user_code_hash: "user-hash",
  client_id: "client",
  status: "pending",
  created_at: "2026-01-01T00:00:00.000Z",
  expires_at: "2030-01-01T00:00:00.000Z",
  version: 0,
  interval: 5,
};
function setup() {
  const send = vi.fn();
  const adapter = createDeviceCodesAdapter({
    client: { send } as unknown as DynamoDBDocumentClient,
    tableName: "test",
  });
  return { send, adapter };
}
afterEach(() => vi.restoreAllMocks());
describe("DynamoDB device authorization commands", () => {
  it("reserves both code hashes atomically with uniqueness conditions and TTLs", async () => {
    const { send, adapter } = setup();
    send.mockResolvedValue({});
    await adapter.create("tenant", code);
    const command = send.mock.calls[0]![0] as TransactWriteCommand;
    expect(command).toBeInstanceOf(TransactWriteCommand);
    const items = command.input.TransactItems!;
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.Put?.ConditionExpression).toBe("attribute_not_exists(PK)");
      expect(item.Put?.Item?.ttl).toBe(Date.parse(code.expires_at) / 1000);
      expect(item.Put?.Item?.PK).toBe("TENANT#tenant#DEVICE_FLOW");
    }
    expect(items[0]!.Put!.Item!.SK).toBe("CODE#device-hash");
    expect(items[1]!.Put!.Item!.SK).toBe("USER#user-hash");
  });
  it("reads both the user-code index and grant strongly consistently", async () => {
    const { send, adapter } = setup();
    send
      .mockResolvedValueOnce({
        Item: { device_code_hash: code.device_code_hash },
      })
      .mockResolvedValueOnce({ Item: code });
    expect(await adapter.getByUserCode("tenant", code.user_code_hash)).toEqual(
      code,
    );
    expect(send).toHaveBeenCalledTimes(2);
    for (const [command] of send.mock.calls) {
      expect(command).toBeInstanceOf(GetCommand);
      expect(command.input.ConsistentRead).toBe(true);
      expect(command.input.Key.PK).toBe("TENANT#tenant#DEVICE_FLOW");
    }
  });
  it("guards updates with the version, increments it, and distinguishes conflicts from outages", async () => {
    const { send, adapter } = setup();
    send.mockResolvedValueOnce({});
    expect(
      await adapter.update("tenant", code.device_code_hash, 0, {
        status: "approved",
        login_id: "browser",
      }),
    ).toBe(true);
    const command = send.mock.calls[0]![0] as UpdateCommand;
    expect(command.input.ConditionExpression).toBe("#version = :expected");
    expect(command.input.ExpressionAttributeValues).toMatchObject({
      ":expected": 0,
      ":v0": "approved",
      ":v1": "browser",
      ":v2": 1,
    });
    send.mockRejectedValueOnce(
      Object.assign(new Error("conflict"), {
        name: "ConditionalCheckFailedException",
      }),
    );
    expect(
      await adapter.update("tenant", code.device_code_hash, 0, {
        status: "consumed",
      }),
    ).toBe(false);
    send.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(
      adapter.update("tenant", code.device_code_hash, 1, {
        status: "consumed",
      }),
    ).rejects.toThrow("database unavailable");
  });
  it("atomically increments throttle buckets and attaches an expiry", async () => {
    const { send, adapter } = setup();
    send.mockResolvedValueOnce({ Attributes: { attempts: 3 } });
    expect(
      await adapter.incrementAttempts("tenant", "bucket", code.expires_at),
    ).toBe(3);
    const command = send.mock.calls[0]![0] as UpdateCommand;
    expect(command.input.Key).toEqual({
      PK: "TENANT#tenant#DEVICE_FLOW",
      SK: "LIMIT#bucket",
    });
    expect(command.input.UpdateExpression).toBe(
      "SET #ttl = :ttl ADD #attempts :one",
    );
    expect(command.input.ReturnValues).toBe("UPDATED_NEW");
    expect(command.input.ExpressionAttributeValues).toMatchObject({
      ":ttl": Date.parse(code.expires_at) / 1000,
      ":one": 1,
    });
  });
});
