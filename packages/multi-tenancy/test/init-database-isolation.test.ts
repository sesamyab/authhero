import { describe, it, expect, beforeEach } from "vitest";
import createAdapters from "@authhero/kysely-adapter";
import { encodeBase64Url } from "@authhero/adapter-interfaces";
import { init } from "authhero";
import { initMultiTenant } from "../src/init";
import { createMigratedDb } from "./helpers/migrated-db";

const CONTROL_PLANE = "control_plane";
const CHILD = "acme";
const ISSUER = "https://auth.example.com/";
const MANAGEMENT_AUDIENCE = "urn:authhero:management";

function pemToDer(pem: string): ArrayBuffer {
  const base64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;
}

async function signRs256(
  pkcs8Pem: string,
  kid: string,
  claims: Record<string, unknown>,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pkcs8Pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const encode = (value: unknown) =>
    encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  const signingInput = `${encode({ alg: "RS256", typ: "JWT", kid })}.${encode(claims)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/**
 * `databaseIsolation` on `initMultiTenant` reaches the provisioning hooks:
 * `onProvision` / `onDeprovision` run, and the default clients are left to the
 * tenant's own database instead of being written to the control plane's.
 */
describe("initMultiTenant: databaseIsolation", () => {
  const provisioned: string[] = [];
  const deprovisioned: string[] = [];
  let adapters: ReturnType<typeof createAdapters>;
  let request: (
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<Response>;

  beforeEach(async () => {
    provisioned.length = 0;
    deprovisioned.length = 0;
    adapters = createAdapters(await createMigratedDb());
    await adapters.tenants.create({
      id: CONTROL_PLANE,
      friendly_name: CONTROL_PLANE,
      audience: `https://${CONTROL_PLANE}.example.com`,
      sender_email: "admin@example.com",
      sender_name: CONTROL_PLANE,
    });

    const { createX509Certificate } = init({ dataAdapter: adapters });
    const signingKey = await createX509Certificate({ name: "CN=test" });
    await adapters.keys.create({ ...signingKey, type: "jwt_signing" });

    const { app } = initMultiTenant({
      dataAdapter: adapters,
      controlPlane: {
        tenantId: CONTROL_PLANE,
        clientId: "control-plane-client",
      },
      databaseIsolation: {
        getAdapters: async () => adapters,
        onProvision: async (tenantId) => {
          provisioned.push(tenantId);
        },
        recordProvisionOperations: false,
        onDeprovision: async (tenantId) => {
          deprovisioned.push(tenantId);
        },
      },
    });
    const now = Math.floor(Date.now() / 1000);
    const token = await signRs256(signingKey.pkcs7!, signingKey.kid, {
      iss: ISSUER,
      aud: MANAGEMENT_AUDIENCE,
      sub: "admin",
      tenant_id: CONTROL_PLANE,
      permissions: ["create:tenants", "delete:tenants", "read:tenants"],
      iat: now,
      exp: now + 3600,
    });
    const env = {
      ISSUER,
      AUTH_URL: "https://auth.example.com",
      ENVIRONMENT: "test",
    };
    request = (method, path, body) =>
      app.request(
        path,
        {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "tenant-id": CONTROL_PLANE,
            "content-type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
        env,
      );
  });

  it("provisions and deprovisions the tenant's database, not the control plane's clients", async () => {
    const created = await request("POST", "/api/v2/tenants", {
      id: CHILD,
      friendly_name: CHILD,
      audience: `https://${CHILD}.example.com`,
      sender_email: "admin@example.com",
      sender_name: CHILD,
    });
    expect(created.status).toBe(201);
    expect(provisioned).toEqual([CHILD]);
    // Pooled provisioning would have written these here.
    expect((await adapters.clients.list(CHILD)).clients).toHaveLength(0);

    const deleted = await request("DELETE", `/api/v2/tenants/${CHILD}`);
    expect(deleted.status).toBe(204);
    expect(deprovisioned).toEqual([CHILD]);
  });
});
