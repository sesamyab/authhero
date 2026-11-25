import { describe, it, expect, beforeEach } from "vitest";
import type { ConnectionSelfService } from "@authhero/adapter-interfaces";
import { getTestServer } from "../helpers/test-server";

// The internal Self-Service SSO state (#1763) round-trips through the
// `connections.self_service` JSON column; ordinary connections have none.
describe("connections self_service", () => {
  let data: ReturnType<typeof getTestServer>["data"];
  const tenantId = "t1";
  const selfService: ConnectionSelfService = {
    profile_id: "ssp_1",
    domains: [
      {
        domain: "example.com",
        status: "verified",
        verified_at: "2026-11-18T00:00:00.000Z",
      },
      { domain: "pending.example", status: "pending" },
    ],
  };

  beforeEach(async () => {
    data = getTestServer().data;
    await data.tenants.create({ id: tenantId, name: "Tenant 1" });
  });

  it("is absent on an ordinary connection", async () => {
    const created = await data.connections.create(tenantId, {
      id: "con-plain",
      name: "plain",
      strategy: "oidc",
      options: {},
    });
    expect(created.self_service).toBeUndefined();
    const read = await data.connections.get(tenantId, "con-plain");
    expect(read?.self_service).toBeUndefined();
  });

  it("is stored on create and read back by get and list", async () => {
    await data.connections.create(tenantId, {
      id: "con-ss",
      name: "self-service",
      strategy: "oidc",
      options: {},
      self_service: selfService,
    });

    const read = await data.connections.get(tenantId, "con-ss");
    expect(read?.self_service).toEqual(selfService);

    const { connections } = await data.connections.list(tenantId);
    expect(connections.find((c) => c.id === "con-ss")?.self_service).toEqual(
      selfService,
    );
  });

  it("is left alone by an update that does not name it, set by one that does, and cleared by null", async () => {
    await data.connections.create(tenantId, {
      id: "con-ss",
      name: "self-service",
      strategy: "oidc",
      options: {},
    });

    await data.connections.update(tenantId, "con-ss", {
      self_service: selfService,
    });
    expect(
      (await data.connections.get(tenantId, "con-ss"))?.self_service,
    ).toEqual(selfService);

    await data.connections.update(tenantId, "con-ss", {
      display_name: "Renamed",
    });
    const renamed = await data.connections.get(tenantId, "con-ss");
    expect(renamed?.display_name).toBe("Renamed");
    expect(renamed?.self_service).toEqual(selfService);

    await data.connections.update(tenantId, "con-ss", { self_service: null });
    expect(
      (await data.connections.get(tenantId, "con-ss"))?.self_service,
    ).toBeUndefined();
  });
});
