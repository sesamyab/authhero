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

const sy = (prefix: string, tail = "0") => `${prefix}sy${tail.padEnd(15, "0")}`;

/**
 * Rows a config sync copied into a tenant keep the parent's `override` and
 * `enforce`. protect-synced must stop the child from editing what is locked,
 * deleting enforced rows, or unlocking a row, without getting in the way of the
 * tenant's own rows or of a whole-record PATCH that changes nothing locked.
 */
describe("protect-synced locks synced copies by override and enforce", () => {
  let request: (
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<Response>;

  beforeEach(async () => {
    const adapters = createAdapters(await createMigratedDb());
    for (const id of [CONTROL_PLANE, CHILD]) {
      await adapters.tenants.create({
        id,
        friendly_name: id,
        audience: `https://${id}.example.com`,
        sender_email: "admin@example.com",
        sender_name: id,
      });
    }
    const { createX509Certificate } = init({ dataAdapter: adapters });
    const signingKey = await createX509Certificate({ name: "CN=test" });
    await adapters.keys.create({ ...signingKey, type: "jwt_signing" });

    const conn = (id: string, name: string, extra: Record<string, unknown>) =>
      adapters.connections.create(CHILD, {
        id,
        name,
        strategy: "google-oauth2",
        options: { client_id: "cp", client_secret: "cp-secret" },
        scope: "shared",
        ...extra,
      });
    await conn(sy("con_", "1"), "locked", { override: "none" });
    await conn(sy("con_", "2"), "secrets-only", { override: "secrets" });
    await conn(sy("con_", "3"), "editable", { override: "fields" });
    await conn(sy("con_", "4"), "enforced", {
      override: "fields",
      enforce: true,
    });
    // The tenant's own row, even with a restrictive flag, is not locked.
    await conn("con_own", "own", { override: "none" });

    await adapters.hooks.create(CHILD, {
      hook_id: sy("h_"),
      trigger_id: "post-user-login",
      url: "https://example.com/hook",
      enabled: true,
      scope: "shared",
      override: "fields",
      enforce: true,
    } as never);
    await adapters.hookCode.create(
      CHILD,
      { code: "exports.onExecutePostLogin = async () => {};" },
      { importMetadata: { id: sy("hc_") } },
    );
    await adapters.actions.create(
      CHILD,
      {
        name: "secrets-action",
        code: "exports.onExecutePostLogin = async () => {};",
        scope: "shared",
        override: "secrets",
        secrets: [{ name: "KEY", value: "v1" }],
      },
      { importMetadata: { id: sy("act_") } },
    );
    await adapters.resourceServers.create(CHILD, {
      id: sy("api_"),
      identifier: "https://synced.example.com",
      name: "synced-api",
      scope: "shared",
      override: "none",
    });

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
      permissions: [
        "read:connections",
        "update:connections",
        "delete:connections",
        "update:hooks",
        "delete:hooks",
        "update:actions",
        "delete:actions",
        "update:resource_servers",
        "delete:resource_servers",
      ],
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
            "tenant-id": CHILD,
            "content-type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
        env,
      );
  });

  const patchConnection = (id: string, body: unknown) =>
    request("PATCH", `/api/v2/connections/${id}`, body);

  it("refuses every edit when override is none, but allows the delete", async () => {
    const patch = await patchConnection(sy("con_", "1"), {
      display_name: "changed",
    });
    expect(patch.status).toBe(403);
    expect(await patch.text()).toMatch(/synced from a parent tenant/);

    // Deleting is allowed (only `enforce` forbids it), so the row goes away.
    const del = await request(
      "DELETE",
      `/api/v2/connections/${sy("con_", "1")}`,
    );
    expect(del.status).toBeLessThan(300);
    expect(
      (await request("GET", `/api/v2/connections/${sy("con_", "1")}`)).status,
    ).toBe(404);
  });

  it("lets a child change only secrets when override is secrets", async () => {
    const id = sy("con_", "2");

    expect(
      (
        await patchConnection(id, {
          options: { client_id: "cp", client_secret: "child-secret" },
        })
      ).status,
    ).toBe(200);

    const nonSecret = await patchConnection(id, {
      options: { client_id: "hijacked", client_secret: "child-secret" },
    });
    expect(nonSecret.status).toBe(403);
    expect(await nonSecret.text()).toMatch(/options\.client_id/);

    expect((await patchConnection(id, { display_name: "x" })).status).toBe(403);
  });

  it("allows only the known secret options, not anything that merely contains 'token'", async () => {
    const id = sy("con_", "2");

    const endpoint = await patchConnection(id, {
      options: {
        client_id: "cp",
        client_secret: "cp-secret",
        token_endpoint: "https://evil.example.com/token",
      },
    });
    expect(endpoint.status).toBe(403);
    expect(await endpoint.text()).toMatch(/options\.token_endpoint/);

    expect(
      (
        await patchConnection(id, {
          options: {
            client_id: "cp",
            client_secret: "cp-secret",
            twilio_token: "child-twilio",
          },
        })
      ).status,
    ).toBe(200);
  });

  it("accepts a whole-record PATCH that changes nothing locked", async () => {
    const id = sy("con_", "2");
    const read = await request("GET", `/api/v2/connections/${id}`);
    expect(read.status).toBe(200);
    const record = await read.json();
    expect(record.name).toBe("secrets-only");

    const response = await patchConnection(id, {
      name: record.name,
      strategy: record.strategy,
      scope: record.scope,
      override: record.override,
      options: { ...record.options, client_secret: "rotated" },
    });
    expect(response.status).toBe(200);
  });

  it("allows edits when override is fields, but never the publishing properties", async () => {
    const id = sy("con_", "3");
    expect((await patchConnection(id, { display_name: "ok" })).status).toBe(
      200,
    );
    for (const body of [
      { scope: "local" },
      { override: "fields", enforce: true },
      { enforce: true },
    ]) {
      expect((await patchConnection(id, body)).status).toBe(403);
    }
  });

  it("refuses to delete an enforced row", async () => {
    expect(
      (await request("DELETE", `/api/v2/connections/${sy("con_", "4")}`))
        .status,
    ).toBe(403);
    expect((await request("DELETE", `/api/v2/hooks/${sy("h_")}`)).status).toBe(
      403,
    );
  });

  it("refuses to disable an enforced hook but allows other edits", async () => {
    const disable = await request("PATCH", `/api/v2/hooks/${sy("h_")}`, {
      enabled: false,
    });
    expect(disable.status).toBe(403);
    expect(await disable.text()).toMatch(/cannot be disabled/);

    expect(
      (await request("PATCH", `/api/v2/hooks/${sy("h_")}`, { priority: 5 }))
        .status,
    ).toBe(200);
  });

  it("never lets a child edit or delete code copied for a hook", async () => {
    expect(
      (
        await request("PATCH", `/api/v2/hook-code/${sy("hc_")}`, {
          code: "// changed",
        })
      ).status,
    ).toBe(403);
    expect(
      (await request("DELETE", `/api/v2/hook-code/${sy("hc_")}`)).status,
    ).toBe(403);
  });

  it("applies the same rules to actions and resource servers", async () => {
    expect(
      (
        await request("PATCH", `/api/v2/actions/actions/${sy("act_")}`, {
          code: "// changed",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("PATCH", `/api/v2/actions/actions/${sy("act_")}`, {
          secrets: [{ name: "KEY", value: "v2" }],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request("PATCH", `/api/v2/resource-servers/${sy("api_")}`, {
          name: "changed",
        })
      ).status,
    ).toBe(403);
  });

  it("does not lock the tenant's own rows", async () => {
    expect(
      (await patchConnection("con_own", { display_name: "mine" })).status,
    ).toBe(200);
  });
});
