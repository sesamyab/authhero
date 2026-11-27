import { describe, it, expect } from "vitest";
import { getAdminToken } from "../helpers/token";
import { getTestServer } from "../helpers/test-server";

const TENANT = "tenantId";

describe("management-api HEAD requests", () => {
  it("answers HEAD like GET when there is no token", async () => {
    const { managementApp, env } = await getTestServer();

    for (const path of ["/users", "/users/email%7CuserId", "/clients"]) {
      const get = await managementApp.request(
        path,
        { headers: { "tenant-id": TENANT } },
        env,
      );
      const head = await managementApp.request(
        path,
        { method: "HEAD", headers: { "tenant-id": TENANT } },
        env,
      );

      expect(get.status).toBe(401);
      expect(head.status).toBe(401);
    }
  });

  it("answers HEAD the same for a resource that exists and one that does not", async () => {
    const { managementApp, env } = await getTestServer();

    const existing = await managementApp.request(
      "/users/email%7CuserId",
      { method: "HEAD", headers: { "tenant-id": TENANT } },
      env,
    );
    const missing = await managementApp.request(
      "/users/email%7Cmissing",
      { method: "HEAD", headers: { "tenant-id": TENANT } },
      env,
    );

    expect(existing.status).toBe(401);
    expect(missing.status).toBe(401);
  });

  it("serves HEAD to a caller with the route's permission", async () => {
    const { managementApp, env } = await getTestServer();
    const token = await getAdminToken();

    const response = await managementApp.request(
      "/users",
      {
        method: "HEAD",
        headers: { "tenant-id": TENANT, authorization: `Bearer ${token}` },
      },
      env,
    );

    expect(response.status).toBe(200);
  });

  it("refuses HEAD to a caller without the route's permission", async () => {
    const { managementApp, env } = await getTestServer();
    const token = await getAdminToken({ permissions: ["read:clients"] });

    const response = await managementApp.request(
      "/users",
      {
        method: "HEAD",
        headers: { "tenant-id": TENANT, authorization: `Bearer ${token}` },
      },
      env,
    );

    expect(response.status).toBe(403);
  });
});
