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
 * An organization-scoped control-plane token that carries only `org_id`, sent
 * through the real authentication middleware to the tenants router: the
 * middleware resolves the organization's name and the delete handler then
 * accepts the token's own tenant and refuses another one.
 */
describe("initMultiTenant: org_id-only token deleting a tenant", () => {
  let adapters: ReturnType<typeof createAdapters>;
  let orgId: string;
  let del: (id: string) => Promise<Response>;

  beforeEach(async () => {
    adapters = createAdapters(await createMigratedDb());
    for (const id of [CONTROL_PLANE, CHILD, "globex"]) {
      await adapters.tenants.create({
        id,
        friendly_name: id,
        audience: `https://${id}.example.com`,
        sender_email: "admin@example.com",
        sender_name: id,
      });
    }
    const org = await adapters.organizations.create(CONTROL_PLANE, {
      name: CHILD,
      display_name: CHILD,
    });
    orgId = org.id;

    const { createX509Certificate } = init({ dataAdapter: adapters });
    const signingKey = await createX509Certificate({ name: "CN=test" });
    await adapters.keys.create({ ...signingKey, type: "jwt_signing" });

    const { app } = initMultiTenant({
      dataAdapter: adapters,
      controlPlane: {
        tenantId: CONTROL_PLANE,
        clientId: "control-plane-client",
      },
    });
    const now = Math.floor(Date.now() / 1000);
    const token = await signRs256(signingKey.pkcs7!, signingKey.kid, {
      iss: ISSUER,
      aud: MANAGEMENT_AUDIENCE,
      sub: "acme-admin",
      tenant_id: CONTROL_PLANE,
      org_id: orgId,
      permissions: ["delete:tenants", "read:tenants"],
      iat: now,
      exp: now + 3600,
    });
    const env = {
      ISSUER,
      AUTH_URL: "https://auth.example.com",
      ENVIRONMENT: "test",
    };
    del = (id) =>
      app.request(
        `/api/v2/tenants/${id}`,
        {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${token}`,
            "tenant-id": CONTROL_PLANE,
          },
        },
        env,
      );
  });

  it("deletes its own tenant and no other", async () => {
    expect((await del("globex")).status).toBe(403);
    expect(await adapters.tenants.get("globex")).not.toBeNull();

    expect((await del(CHILD)).status).toBe(204);
    expect(await adapters.tenants.get(CHILD)).toBeNull();
  });
});
