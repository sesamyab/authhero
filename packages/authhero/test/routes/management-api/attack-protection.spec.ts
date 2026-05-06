import { describe, it, expect } from "vitest";
import { testClient } from "hono/testing";
import { getAdminToken } from "../../helpers/token";
import { getTestServer } from "../../helpers/test-server";

describe("attack-protection", () => {
  it("returns empty defaults, then updates each section independently", async () => {
    const { managementApp, env } = await getTestServer();
    const client = testClient(managementApp, env);
    const token = await getAdminToken();

    const auth = { authorization: `Bearer ${token}` };
    const json = { ...auth, "content-type": "application/json" };

    // Empty initially — each section returns {}
    const initialBf = await client["attack-protection"][
      "brute-force-protection"
    ].$get({ header: { "tenant-id": "tenantId" } }, { headers: auth });
    expect(initialBf.status).toBe(200);
    expect(await initialBf.json()).toEqual({});

    // PATCH brute-force-protection
    const bfPatch = await client["attack-protection"][
      "brute-force-protection"
    ].$patch(
      {
        header: { "tenant-id": "tenantId" },
        json: {
          enabled: true,
          mode: "count_per_identifier_and_ip",
          max_attempts: 10,
        },
      },
      { headers: json },
    );
    expect(bfPatch.status).toBe(200);
    expect(await bfPatch.json()).toEqual({
      enabled: true,
      mode: "count_per_identifier_and_ip",
      max_attempts: 10,
    });

    // PATCH breached-password-detection
    const bpdPatch = await client["attack-protection"][
      "breached-password-detection"
    ].$patch(
      {
        header: { "tenant-id": "tenantId" },
        json: { enabled: true, shields: ["block"] },
      },
      { headers: json },
    );
    expect(bpdPatch.status).toBe(200);
    expect((await bpdPatch.json()).shields).toEqual(["block"]);

    // GET each section independently
    const bfGet = await client["attack-protection"][
      "brute-force-protection"
    ].$get({ header: { "tenant-id": "tenantId" } }, { headers: auth });
    expect(bfGet.status).toBe(200);
    expect((await bfGet.json()).max_attempts).toBe(10);

    const bpdGet = await client["attack-protection"][
      "breached-password-detection"
    ].$get({ header: { "tenant-id": "tenantId" } }, { headers: auth });
    expect(bpdGet.status).toBe(200);
    expect((await bpdGet.json()).enabled).toBe(true);

    // Untouched section still returns empty
    const sipGet = await client["attack-protection"][
      "suspicious-ip-throttling"
    ].$get({ header: { "tenant-id": "tenantId" } }, { headers: auth });
    expect(sipGet.status).toBe(200);
    expect(await sipGet.json()).toEqual({});
  });
});
