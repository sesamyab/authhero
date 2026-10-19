import { describe, expect, it } from "vitest";
import { defineKeysetConformance } from "../../../adapter-interfaces/test-utils/keyset-conformance";
import { getTestServer } from "../helpers/test-server";

defineKeysetConformance({
  describe,
  it,
  expect,
  name: "drizzle",
  setup: async () => {
    const { data } = getTestServer();
    await data.tenants.create({ id: "t1", name: "Tenant 1" });
    return { data, tenantId: "t1" };
  },
});
