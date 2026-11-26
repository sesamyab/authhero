import { describe, it, expect, beforeEach } from "vitest";
import { getTestServer } from "../helpers/test-server";

// Connection-level booleans are stored as integer columns and must come back
// as real booleans, otherwise `show_as_button === false` checks never match.
describe("connections show_as_button / is_domain_connection", () => {
  let data: Awaited<ReturnType<typeof getTestServer>>["data"];
  const tenantId = "tenantId";
  const TENANT = {
    id: tenantId,
    friendly_name: "Test Tenant",
    audience: "https://example.com",
    sender_email: "login@example.com",
    sender_name: "SenderName",
  };
  const setup = async () => (await getTestServer()).data;

  async function createTenant() {
    await data.tenants.create(TENANT);
  }

  beforeEach(async () => {
    data = await setup();
    await createTenant();
  });

  it.each([true, false])(
    "round-trips show_as_button=%s through create, get and list",
    async (value) => {
      const created = await data.connections.create(tenantId, {
        id: "con-1",
        name: "conn",
        strategy: "oidc",
        options: {},
        show_as_button: value,
        is_domain_connection: value,
      });
      expect(created.show_as_button).toBe(value);
      expect(created.is_domain_connection).toBe(value);

      const read = await data.connections.get(tenantId, "con-1");
      expect(read?.show_as_button).toBe(value);
      expect(read?.is_domain_connection).toBe(value);

      const { connections } = await data.connections.list(tenantId);
      expect(connections[0]?.show_as_button).toBe(value);
      expect(connections[0]?.is_domain_connection).toBe(value);
    },
  );

  it("leaves show_as_button unset when not provided", async () => {
    const created = await data.connections.create(tenantId, {
      id: "con-1",
      name: "conn",
      strategy: "oidc",
      options: {},
    });
    expect(created.show_as_button).toBeUndefined();
    expect(created.is_domain_connection).toBeUndefined();

    const read = await data.connections.get(tenantId, "con-1");
    expect(read?.show_as_button).toBeUndefined();
    expect(read?.is_domain_connection).toBeUndefined();

    const { connections } = await data.connections.list(tenantId);
    expect(connections[0]?.show_as_button).toBeUndefined();
  });

  it("updates show_as_button and keeps it when omitted", async () => {
    await data.connections.create(tenantId, {
      id: "con-1",
      name: "conn",
      strategy: "oidc",
      options: {},
    });

    await data.connections.update(tenantId, "con-1", {
      show_as_button: false,
      is_domain_connection: true,
    });
    let read = await data.connections.get(tenantId, "con-1");
    expect(read?.show_as_button).toBe(false);
    expect(read?.is_domain_connection).toBe(true);

    await data.connections.update(tenantId, "con-1", {
      display_name: "Renamed",
    });
    read = await data.connections.get(tenantId, "con-1");
    expect(read?.show_as_button).toBe(false);
    expect(read?.is_domain_connection).toBe(true);

    await data.connections.update(tenantId, "con-1", {
      show_as_button: true,
    });
    read = await data.connections.get(tenantId, "con-1");
    expect(read?.show_as_button).toBe(true);
  });
});
