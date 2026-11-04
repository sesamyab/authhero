import { describe, it, expect } from "vitest";
import createAdapters from "@authhero/kysely-adapter";
import { encodeBase64Url } from "@authhero/adapter-interfaces";
import {
  init,
  createEncryptedDataAdapterWithKeyRing,
  loadEncryptionKey,
  type DataAdapters,
} from "authhero";
import { initMultiTenant } from "../src/init";
import { createInProcessSyncConfig } from "../src";
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

const key = (seed: number) =>
  loadEncryptionKey(Buffer.alloc(32, seed).toString("base64"));

/**
 * A control plane that encrypts at rest. `dataAdapter` decrypts on read, as it
 * has to for requests; `raw` returns secrets as stored, which is what a push to
 * a tenant with its own database copies and hashes (`syncDefaults` reads it).
 */
async function setup(options: { storedDataAdapter: boolean }) {
  const raw = createAdapters(await createMigratedDb()) as DataAdapters;
  const encrypted = createEncryptedDataAdapterWithKeyRing(
    raw,
    { default: await key(1), keys: { cp: await key(2) } },
    {
      resolveEncryptKeyId: (tenantId) =>
        tenantId === CONTROL_PLANE ? "cp" : undefined,
    },
  );

  for (const id of [CONTROL_PLANE, CHILD]) {
    await raw.tenants.create({
      id,
      friendly_name: id,
      audience: `https://${id}.example.com`,
      sender_email: "admin@example.com",
      sender_name: id,
      ...(id === CONTROL_PLANE ? {} : { config_sync: "synced" as const }),
    });
  }
  // A published row with a secret: ciphertext in `raw`, plaintext in `encrypted`.
  await encrypted.connections.create(CONTROL_PLANE, {
    id: "google",
    name: "google-oauth2",
    strategy: "google-oauth2",
    options: { client_id: "client", client_secret: "s3cret" },
    scope: "shared",
  } as never);

  const { createX509Certificate } = init({ dataAdapter: raw });
  const signingKey = await createX509Certificate({ name: "CN=test" });
  await raw.keys.create({ ...signingKey, type: "jwt_signing" });

  const result = initMultiTenant({
    dataAdapter: encrypted,
    ...(options.storedDataAdapter ? { storedDataAdapter: raw } : {}),
    // The transport of a tenant with its own database reads the stored layer.
    syncDefaults: createInProcessSyncConfig(raw, {
      controlPlaneTenantId: CONTROL_PLANE,
    }),
    controlPlane: { tenantId: CONTROL_PLANE, clientId: "control-plane-client" },
  });

  const now = Math.floor(Date.now() / 1000);
  const token = await signRs256(signingKey.pkcs7!, signingKey.kid, {
    iss: ISSUER,
    aud: MANAGEMENT_AUDIENCE,
    sub: "admin",
    tenant_id: CONTROL_PLANE,
    permissions: [
      "read:tenants",
      "read:tenant_operations",
      "create:tenant_operations",
    ],
    iat: now,
    exp: now + 3600,
  });
  const env = {
    ISSUER,
    AUTH_URL: "https://auth.example.com",
    ENVIRONMENT: "test",
  };
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await result.app.request(
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
    return { status: response.status, body: (await response.json()) as any };
  };

  return { raw, encrypted, request };
}

describe("storedDataAdapter", () => {
  it("makes the sync status agree with a push that copies secrets as stored", async () => {
    const { raw, request } = await setup({ storedDataAdapter: true });

    // The row really is ciphertext where the sync reads it, and tagged `cp`.
    const stored = await raw.connections.get(CONTROL_PLANE, "google");
    expect(stored?.options?.client_secret).toMatch(/^enc:v1:cp:/);

    const sync = await request("POST", `/api/v2/tenants/${CHILD}/operations`, {
      kind: "sync-defaults",
    });
    expect(sync.body.status).toBe("succeeded");

    const status = await request("GET", `/api/v2/tenants/${CHILD}/config-sync`);
    expect(status.body.config_sync_hash).toBeTruthy();
    expect(status.body.expected_hash).toBe(status.body.config_sync_hash);
    expect(status.body.drifted).toBe(false);

    const verify = await request(
      "GET",
      `/api/v2/tenants/${CHILD}/config-sync/verify`,
    );
    expect(verify.body).toMatchObject({ ok: true, differences: [] });
  });

  it("does not leave a tenant with a copy it cannot read", async () => {
    const { raw, request } = await setup({ storedDataAdapter: true });
    await request("POST", `/api/v2/tenants/${CHILD}/operations`, {
      kind: "sync-defaults",
    });

    // What a sync delivered is the stored ciphertext, not a re-encryption.
    const copies = (await raw.connections.list(CHILD)).connections;
    const copy = copies.find((c) => c.strategy === "google-oauth2");
    expect(copy?.options?.client_secret).toMatch(/^enc:v1:cp:/);
  });

  it("is the reason `drifted` stays true without it: the two layers hash differently", async () => {
    // Same setup without the option: status reads through the decrypting layer
    // while the push read the stored one, so the hashes never meet.
    const { request } = await setup({ storedDataAdapter: false });

    const sync = await request("POST", `/api/v2/tenants/${CHILD}/operations`, {
      kind: "sync-defaults",
    });
    expect(sync.body.status).toBe("succeeded");

    const status = await request("GET", `/api/v2/tenants/${CHILD}/config-sync`);
    expect(status.body.config_sync_hash).toBeTruthy();
    expect(status.body.expected_hash).not.toBe(status.body.config_sync_hash);
    expect(status.body.drifted).toBe(true);
  });
});
