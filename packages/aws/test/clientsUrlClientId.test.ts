import { afterEach, describe, expect, it } from "vitest";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { getTestServer, teardownTestServer } from "./helpers/test-server";

// #1731: a URL (CIMD) client_id can have a row in several tenants. The legacy
// client_id → tenant pointer holds one tenant, so it must never resolve one.
describe("getByClientId with a URL client_id", () => {
  afterEach(async () => {
    await teardownTestServer();
  });

  const CIMD_URL = "https://claude.ai/oauth/mcp-oauth-client-metadata";

  it("returns null even when a legacy pointer exists", async () => {
    const { data, client, tableName } = await getTestServer();
    for (const id of ["tenantA", "tenantB"]) {
      await data.tenants.create({
        id,
        friendly_name: id,
        audience: `https://${id}.example.com`,
        sender_email: "login@example.com",
        sender_name: "SenderName",
      });
      await data.clients.create(id, {
        client_id: CIMD_URL,
        name: "Claude",
        client_metadata: { cimd: "true" },
      });
    }
    await data.clients.create("tenantA", {
      client_id: "legacy-client",
      name: "Legacy",
    });
    for (const clientId of [CIMD_URL, "legacy-client"]) {
      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            PK: "LEGACY_CLIENTS",
            SK: `LEGACY_CLIENT#${clientId}`,
            tenant_id: "tenantA",
          },
        }),
      );
    }

    expect(await data.clients.getByClientId(CIMD_URL)).toBeNull();
    // Tenant-scoped reads and non-URL client_ids are unchanged.
    expect((await data.clients.get("tenantB", CIMD_URL))?.client_id).toBe(
      CIMD_URL,
    );
    expect((await data.clients.getByClientId("legacy-client"))?.tenant_id).toBe(
      "tenantA",
    );
  });
});
