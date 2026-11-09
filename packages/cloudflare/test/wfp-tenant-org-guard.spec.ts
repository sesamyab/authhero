import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Kysely, SqliteDialect } from "kysely";
import SQLite from "better-sqlite3";
import createAdapters, {
  Database,
  migrateToLatest,
} from "@authhero/kysely-adapter";
import type { DataAdapters, SigningKey } from "@authhero/adapter-interfaces";
import { init } from "authhero";
import { createWfpTenantApp } from "../src/wfp";

const CP = "control_plane";
const CP_ISSUER = "https://control.example.com/";
const MANAGEMENT = "urn:authhero:management";

/** `AUTH_DB` stands in for the D1 binding; `createDataAdapter` ignores it. */
function workerEnv(tenantId: string | undefined) {
  return {
    AUTH_DB: {},
    ENCRYPTION_KEY: Buffer.from(new Uint8Array(32).fill(1)).toString("base64"),
    ISSUER: "https://bob.tokens.example.com/",
    ...(tenantId ? { TENANT_ID: tenantId } : {}),
    CONTROL_PLANE_TENANT_ID: CP,
    CONTROL_PLANE_ISSUER: CP_ISSUER,
    WFP_INTERNAL_SYNC_SECRET: "push-secret",
  };
}
const ctx = { waitUntil() {}, passThroughOnException() {} };

async function makeAdapters(): Promise<DataAdapters> {
  const sqlite = new SQLite(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = new Kysely<Database>({
    dialect: new SqliteDialect({ database: sqlite }),
  });
  await migrateToLatest(db, false);
  return createAdapters(db) as DataAdapters;
}

const tenantRow = (id: string) => ({
  id,
  friendly_name: id,
  audience: "https://example.com",
  default_audience: "https://example.com",
  sender_email: "login@example.com",
  sender_name: "Sender",
});

const base64url = (bytes: ArrayBuffer | Uint8Array | string) =>
  Buffer.from(typeof bytes === "string" ? bytes : new Uint8Array(bytes))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** RS256 over WebCrypto, from the PKCS8 PEM that `createX509Certificate` returns. */
async function signToken(
  signingKey: SigningKey,
  claims: Record<string, unknown>,
): Promise<string> {
  const pem = signingKey
    .pkcs7!.replace(/-----(BEGIN|END)[A-Z ]*PRIVATE KEY-----/g, "")
    .replace(/\s/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    Buffer.from(pem, "base64"),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: signingKey.kid }),
  );
  const payload = base64url(
    JSON.stringify({ iat: now, exp: now + 3600, ...claims }),
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64url(signature)}`;
}

describe("createWfpTenantApp: a control plane token for one tenant's organization", () => {
  let tenant: DataAdapters;
  let controlPlaneKey: SigningKey;

  beforeAll(async () => {
    const throwaway = await makeAdapters();
    controlPlaneKey = await init({
      dataAdapter: throwaway,
    }).createX509Certificate({
      name: "CN=control plane",
    });
  });

  beforeEach(async () => {
    tenant = await makeAdapters();
    await tenant.tenants.create(tenantRow(CP));
    await tenant.tenants.create(tenantRow("bob"));
    await tenant.tenants.create(tenantRow("acme"));
    // The control plane's public key, as a sync projects it: no tenant id.
    await tenant.keys.create({
      kid: controlPlaneKey.kid,
      type: "jwt_signing",
      cert: controlPlaneKey.cert,
      fingerprint: controlPlaneKey.fingerprint,
      thumbprint: controlPlaneKey.thumbprint,
    });
  });

  /** A call to `bob`'s Worker with a control plane token carrying `claims`. */
  async function callBob(
    claims: Record<string, unknown>,
    options: {
      tenantIdVar?: string | undefined;
      requestTenant?: string;
      path?: string;
      method?: string;
    } = {},
  ) {
    const app = createWfpTenantApp({ createDataAdapter: () => tenant });
    const token = await signToken(controlPlaneKey, {
      iss: CP_ISSUER,
      aud: MANAGEMENT,
      sub: "auth0|someone",
      tenant_id: CP,
      permissions: ["read:users", "create:clients"],
      scope: "openid",
      ...claims,
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      return await app.fetch(
        new Request(
          `https://bob.tokens.example.com${options.path ?? "/api/v2/users"}`,
          {
            method: options.method ?? "GET",
            headers: {
              authorization: `Bearer ${token}`,
              "tenant-id": options.requestTenant ?? "bob",
              "content-type": "application/json",
            },
            ...(options.method === "POST" ? { body: "{}" } : {}),
          },
        ),
        workerEnv("tenantIdVar" in options ? options.tenantIdVar : "bob"),
        ctx,
      );
    } finally {
      errors.mockRestore();
    }
  }

  it("lets a member of this tenant in", async () => {
    const res = await callBob({ org_id: "org_bob", org_name: "bob" });
    expect(res.status).toBe(200);
  });

  it("refuses a member of another tenant", async () => {
    const res = await callBob({ org_id: "org_acme", org_name: "acme" });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      statusCode: 403,
      message: expect.stringContaining("another tenant"),
    });
  });

  it("refuses it on a write as well, before the route runs", async () => {
    const res = await callBob(
      { org_id: "org_acme", org_name: "acme" },
      { path: "/api/v2/clients", method: "POST" },
    );
    expect(res.status).toBe(403);
    expect((await tenant.clients.list("bob")).clients).toHaveLength(0);
  });

  it("lets a control plane token without an organization in (an operator)", async () => {
    const res = await callBob({});
    expect(res.status).toBe(200);
  });

  it("refuses a token with an organization id but no organization name", async () => {
    const res = await callBob({ org_id: "org_acme" });
    expect(res.status).toBe(403);
  });

  it("refuses an organization token when the Worker has no TENANT_ID, whatever the request says", async () => {
    // The `tenant-id` header is the caller's own, so it cannot name the tenant
    // this Worker is. An `acme` row exists, so the header resolves.
    for (const path of ["/api/v2/users", "/api/v2/clients"]) {
      const res = await callBob(
        { org_id: "org_acme", org_name: "acme" },
        { tenantIdVar: undefined, requestTenant: "acme", path },
      );
      expect(res.status).toBe(403);
    }

    const own = await callBob(
      { org_id: "org_bob", org_name: "bob" },
      { tenantIdVar: undefined },
    );
    expect(own.status).toBe(403);
  });

  it("still lets an operator token in when the Worker has no TENANT_ID", async () => {
    const res = await callBob({}, { tenantIdVar: undefined });
    expect(res.status).toBe(200);
  });

  it("is not dropped by a `configure` that replaces the management middleware", async () => {
    const app = createWfpTenantApp({
      createDataAdapter: () => tenant,
      configure: (config) => ({ ...config, managementApiMiddleware: [] }),
    });
    const token = await signToken(controlPlaneKey, {
      iss: CP_ISSUER,
      aud: MANAGEMENT,
      sub: "auth0|someone",
      tenant_id: CP,
      permissions: ["read:users"],
      scope: "openid",
      org_id: "org_acme",
      org_name: "acme",
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await app.fetch(
      new Request("https://bob.tokens.example.com/api/v2/users", {
        headers: { authorization: `Bearer ${token}`, "tenant-id": "bob" },
      }),
      workerEnv("bob"),
      ctx,
    );
    errors.mockRestore();

    expect(res.status).toBe(403);
  });
});
