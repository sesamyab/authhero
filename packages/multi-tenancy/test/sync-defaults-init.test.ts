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
 * initMultiTenant wires a default inline executor, so a control-plane operator
 * can sync a tenant as a tracked operation through the management API.
 */
describe("initMultiTenant runs sync-defaults operations", () => {
  let request: (
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<Response>;
  let adapters: ReturnType<typeof createAdapters>;

  beforeEach(async () => {
    adapters = createAdapters(await createMigratedDb());
    for (const id of [CONTROL_PLANE, CHILD]) {
      await adapters.tenants.create({
        id,
        friendly_name: id,
        audience: `https://${id}.example.com`,
        sender_email: "admin@example.com",
        sender_name: id,
      });
    }
    await adapters.actions.create(CONTROL_PLANE, {
      name: "enrich",
      code: "exports.onExecutePostLogin = async () => {};",
      scope: "shared",
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
    });
    const now = Math.floor(Date.now() / 1000);
    const token = await signRs256(signingKey.pkcs7!, signingKey.kid, {
      iss: ISSUER,
      aud: MANAGEMENT_AUDIENCE,
      sub: "admin",
      tenant_id: CONTROL_PLANE,
      permissions: ["create:tenant_operations", "read:tenant_operations"],
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

  const sync = (input?: Record<string, unknown>) =>
    request("POST", `/api/v2/tenants/${CHILD}/operations`, {
      kind: "sync-defaults",
      ...(input ? { input } : {}),
    });

  it("returns the diff of a dry run and writes nothing", async () => {
    const response = await sync({ dry_run: true });

    expect(response.status).toBe(201);
    const operation = await response.json();
    expect(operation).toMatchObject({
      kind: "sync-defaults",
      status: "succeeded",
      input: { dry_run: true },
      result: { status: "dry-run", entities: { action: { added: 1 } } },
    });
    expect((await adapters.actions.list(CHILD)).actions).toHaveLength(0);
  });

  it("syncs for real, keeps history, and the next run is up to date", async () => {
    const first = await (await sync()).json();
    expect(first.result).toMatchObject({ status: "applied" });
    expect((await adapters.actions.list(CHILD)).actions).toHaveLength(1);

    const second = await (await sync()).json();
    expect(second.result).toMatchObject({ status: "up-to-date" });

    const history = await (
      await request(
        "GET",
        `/api/v2/tenants/${CHILD}/operations?kind=sync-defaults`,
      )
    ).json();
    expect(history.operations).toHaveLength(2);

    const detail = await (
      await request("GET", `/api/v2/operations/${first.id}`)
    ).json();
    expect(detail.events.map((e: { outcome: string }) => e.outcome)).toEqual([
      "started",
      "succeeded",
    ]);
  });

  it("returns a failed operation row instead of a 500 when the sync fails", async () => {
    await adapters.tenants.update(CHILD, { deployment_type: "wfp" });

    const response = await sync();

    expect(response.status).toBe(201);
    const operation = await response.json();
    expect(operation).toMatchObject({ status: "failed" });
    expect(operation.error).toMatch(/own database/);
  });

  it("does not offer upgrades when no upgrade handler is configured", async () => {
    const response = await request(
      "POST",
      `/api/v2/tenants/${CHILD}/operations`,
      { kind: "upgrade" },
    );
    expect(response.status).toBe(501);
  });
});
