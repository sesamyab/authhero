import { afterAll, afterEach, describe, expect, it } from "vitest";
import { defineKeysetConformance } from "../../adapter-interfaces/test-utils/keyset-conformance";
import {
  getTestServer,
  clearTestData,
  teardownTestServer,
} from "./helpers/test-server";

// Clear rows between tests rather than recycling the dynalite server — the
// helper documents this as the reliable path.
afterEach(async () => {
  await clearTestData();
});

afterAll(async () => {
  await teardownTestServer();
});

defineKeysetConformance({
  describe,
  it,
  expect,
  name: "aws",
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
