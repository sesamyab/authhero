import { describe, it, expect } from "vitest";
import { getTestServer } from "./helpers/test-server";

const TENANT_ID = "test-tenant";

describe("MigrationSourcesAdapter", () => {
  it("creates, gets, lists, updates, and removes a migration source", async () => {
    const { data } = await getTestServer();
    const adapter = data.migrationSources!;
    expect(adapter).toBeDefined();

    const created = await adapter.create(TENANT_ID, {
      name: "Upstream Auth0",
      provider: "auth0",
      connection: "auth0",
      enabled: true,
      credentials: {
        domain: "tenant.auth0.com",
        client_id: "cid",
        client_secret: "csecret",
        audience: "https://api.example.com",
        scope: "openid profile email offline_access",
      },
    });

    expect(created.id).toBeTypeOf("string");
    expect(created.id.startsWith("mig_")).toBe(true);
    expect(created.created_at).toBeTypeOf("string");
    expect(created.provider).toBe("auth0");
    expect(created.enabled).toBe(true);
    expect(created.credentials.client_secret).toBe("csecret");

    const fetched = await adapter.get(TENANT_ID, created.id);
    expect(fetched).toBeDefined();
    expect(fetched?.name).toBe("Upstream Auth0");
    expect(fetched?.credentials.domain).toBe("tenant.auth0.com");
    expect(fetched?.credentials.audience).toBe("https://api.example.com");

    const list = await adapter.list(TENANT_ID);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(created.id);

    // Other tenant cannot see it
    const otherTenantList = await adapter.list("other-tenant");
    expect(otherTenantList).toHaveLength(0);

    const ok = await adapter.update(TENANT_ID, created.id, {
      enabled: false,
      credentials: {
        domain: "tenant.auth0.com",
        client_id: "cid",
        client_secret: "rotated-csecret",
      },
    });
    expect(ok).toBe(true);

    const afterUpdate = await adapter.get(TENANT_ID, created.id);
    expect(afterUpdate?.enabled).toBe(false);
    expect(afterUpdate?.credentials.client_secret).toBe("rotated-csecret");
    expect(afterUpdate?.credentials.audience).toBeUndefined();

    const removed = await adapter.remove(TENANT_ID, created.id);
    expect(removed).toBe(true);

    const after = await adapter.get(TENANT_ID, created.id);
    expect(after).toBeNull();
  });

  it("returns null for a missing migration source", async () => {
    const { data } = await getTestServer();
    const result = await data.migrationSources!.get(TENANT_ID, "missing-id");
    expect(result).toBeNull();
  });

  it("returns false when updating or removing a missing migration source", async () => {
    const { data } = await getTestServer();
    const updated = await data.migrationSources!.update(
      TENANT_ID,
      "missing-id",
      { enabled: false },
    );
    expect(updated).toBe(false);
    const removed = await data.migrationSources!.remove(
      TENANT_ID,
      "missing-id",
    );
    expect(removed).toBe(false);
  });
});
