import { describe, expect, it } from "vitest";
import { defineKeysetConformance } from "../../adapter-interfaces/test-utils/keyset-conformance";
import { getTestServer } from "./helpers/test-server";

defineKeysetConformance({
  describe,
  it,
  expect,
  name: "kysely",
  setup: async () => {
    const { data } = await getTestServer();
    await data.tenants.create({
      id: "tenantId",
      friendly_name: "Test Tenant",
      audience: "https://example.com",
      sender_email: "login@example.com",
      sender_name: "SenderName",
    });
    return { data, tenantId: "tenantId" };
  },
});
