import {
  describe,
  expect,
  it,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import {
  CloudflareApiClient,
  CloudflareApiError,
  createCloudflareWfpD1Provisioner,
  createWfpTenantProvisioningHook,
} from "../src";
import {
  MAX_MIGRATION_BATCH_BYTES,
  chunkMigrationParts,
  terminateSqlForConcat,
} from "../src/wfp-provisioner/provisioner-steps";
import type { CloudflareWfpD1Provisioner, ProvisionResult } from "../src";
import type { Tenant, TenantsDataAdapter } from "@authhero/adapter-interfaces";

const ACCOUNT_ID = "acc_test";
const NAMESPACE = "authhero-tenants";
const API_BASE = "https://api.cloudflare.com/client/v4";

// Track which CF endpoints get hit, in what order, with which payloads.
// Each test sets up handlers and then asserts the captured sequence.
interface CapturedRequest {
  method: string;
  path: string;
  body: unknown;
}

let captured: CapturedRequest[];

function path(p: string): string {
  return `${API_BASE}${p}`;
}

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  server.resetHandlers();
  captured = [];
});

async function captureBody(req: Request): Promise<unknown> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const out: Record<string, unknown> = {};
    for (const [k, v] of form.entries()) {
      if (v instanceof Blob) {
        out[k] = await v.text();
      } else {
        out[k] = v;
      }
    }
    return out;
  }
  if (ct.includes("application/json")) {
    return await req.json();
  }
  return await req.text();
}

describe("CloudflareApiClient", () => {
  it("createD1Database POSTs the name and returns the uuid", async () => {
    server.use(
      http.post(
        path(`/accounts/${ACCOUNT_ID}/d1/database`),
        async ({ request }) => {
          captured.push({
            method: "POST",
            path: "/d1/database",
            body: await captureBody(request),
          });
          return HttpResponse.json({
            result: { uuid: "db_uuid_1", name: "tenant-kvartal" },
            success: true,
          });
        },
      ),
    );
    const client = new CloudflareApiClient({
      accountId: ACCOUNT_ID,
      apiToken: "token",
    });
    const created = await client.createD1Database("tenant-kvartal");
    expect(created.uuid).toBe("db_uuid_1");
    expect(captured).toHaveLength(1);
    expect(captured[0].body).toEqual({ name: "tenant-kvartal" });
  });

  it("execD1 posts SQL to the query endpoint", async () => {
    server.use(
      http.post(
        path(`/accounts/${ACCOUNT_ID}/d1/database/db_1/query`),
        async ({ request }) => {
          captured.push({
            method: "POST",
            path: "/d1/database/:id/query",
            body: await captureBody(request),
          });
          return HttpResponse.json({
            result: [{ success: true, results: [] }],
            success: true,
          });
        },
      ),
    );
    const client = new CloudflareApiClient({
      accountId: ACCOUNT_ID,
      apiToken: "token",
    });
    const result = await client.execD1("db_1", "CREATE TABLE users (id TEXT);");
    expect(result[0].success).toBe(true);
    expect((captured[0].body as { sql: string }).sql).toContain("CREATE TABLE");
  });

  it("uploadNamespacedScript PUTs a multipart with metadata + main module", async () => {
    server.use(
      http.put(
        path(
          `/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/${NAMESPACE}/scripts/kvartal`,
        ),
        async ({ request }) => {
          captured.push({
            method: "PUT",
            path: "/scripts/kvartal",
            body: await captureBody(request),
          });
          return HttpResponse.json({ result: {}, success: true });
        },
      ),
    );
    const client = new CloudflareApiClient({
      accountId: ACCOUNT_ID,
      apiToken: "token",
    });
    await client.uploadNamespacedScript(NAMESPACE, "kvartal", {
      script: "export default { fetch() { return new Response('ok'); } };",
      mainModule: "index.js",
      compatibilityDate: "2026-05-01",
      compatibilityFlags: ["nodejs_compat"],
      bindings: [{ type: "d1", name: "AUTH_DB", id: "db_uuid_1" }],
    });
    expect(captured).toHaveLength(1);
    const body = captured[0].body as Record<string, string>;
    expect(body["metadata"]).toContain('"main_module":"index.js"');
    expect(body["metadata"]).toContain('"id":"db_uuid_1"');
    expect(body["index.js"]).toContain("Response('ok')");
  });

  it("setNamespacedScriptSecret PUTs one secret at a time", async () => {
    server.use(
      http.put(
        path(
          `/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/${NAMESPACE}/scripts/kvartal/secrets`,
        ),
        async ({ request }) => {
          captured.push({
            method: "PUT",
            path: "/scripts/kvartal/secrets",
            body: await captureBody(request),
          });
          return HttpResponse.json({ result: {}, success: true });
        },
      ),
    );
    const client = new CloudflareApiClient({
      accountId: ACCOUNT_ID,
      apiToken: "token",
    });
    await client.setNamespacedScriptSecret(
      NAMESPACE,
      "kvartal",
      "ENCRYPTION_KEY",
      "supersecret",
    );
    expect(captured[0].body).toEqual({
      name: "ENCRYPTION_KEY",
      text: "supersecret",
      type: "secret_text",
    });
  });

  it("default fetch is not invoked with the client as `this` (workerd brand check)", async () => {
    server.use(
      http.post(path(`/accounts/${ACCOUNT_ID}/d1/database`), () =>
        HttpResponse.json({
          result: { uuid: "db_uuid_strict", name: "tenant-strict" },
          success: true,
        }),
      ),
    );
    // Mimic workerd: the global fetch throws when called with a foreign
    // `this` (e.g. `this.fetchImpl(...)` binding the client instance).
    const realFetch = fetch;
    function strictFetch(
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      if (this !== undefined && this !== globalThis) {
        throw new TypeError(
          "Illegal invocation: function called with incorrect `this` reference.",
        );
      }
      return realFetch(input, init);
    }
    vi.stubGlobal("fetch", strictFetch);
    try {
      const client = new CloudflareApiClient({
        accountId: ACCOUNT_ID,
        apiToken: "token",
      });
      const created = await client.createD1Database("tenant-strict");
      expect(created.uuid).toBe("db_uuid_strict");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("non-2xx responses throw CloudflareApiError with the status + body + errors array", async () => {
    server.use(
      http.post(path(`/accounts/${ACCOUNT_ID}/d1/database`), () =>
        HttpResponse.json(
          {
            errors: [{ code: 7501, message: "Name already taken" }],
            success: false,
          },
          { status: 400 },
        ),
      ),
    );
    const client = new CloudflareApiClient({
      accountId: ACCOUNT_ID,
      apiToken: "token",
    });
    await expect(client.createD1Database("dup")).rejects.toMatchObject({
      name: "CloudflareApiError",
      status: 400,
    });
    // Verify the errors array is preserved
    try {
      await client.createD1Database("dup");
    } catch (err) {
      const cfErr = err as CloudflareApiError;
      expect(cfErr.errors).toEqual([
        { code: 7501, message: "Name already taken" },
      ]);
    }
  });
});

describe("createCloudflareWfpD1Provisioner", () => {
  function setupHappyPath(): void {
    server.use(
      http.get(path(`/accounts/${ACCOUNT_ID}/d1/database`), () =>
        HttpResponse.json({ result: [], success: true }),
      ),
      http.post(
        path(`/accounts/${ACCOUNT_ID}/d1/database`),
        async ({ request }) => {
          captured.push({
            method: "POST",
            path: "/d1/database",
            body: await captureBody(request),
          });
          return HttpResponse.json({
            result: { uuid: "db_kvartal", name: "tenant-kvartal" },
            success: true,
          });
        },
      ),
      http.post(
        path(`/accounts/${ACCOUNT_ID}/d1/database/db_kvartal/query`),
        async ({ request }) => {
          captured.push({
            method: "POST",
            path: "/d1/exec",
            body: await captureBody(request),
          });
          return HttpResponse.json({
            result: [{ success: true, results: [] }],
            success: true,
          });
        },
      ),
      http.put(
        path(
          `/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/${NAMESPACE}/scripts/kvartal`,
        ),
        async ({ request }) => {
          captured.push({
            method: "PUT",
            path: "/scripts/kvartal",
            body: await captureBody(request),
          });
          return HttpResponse.json({ result: {}, success: true });
        },
      ),
      http.put(
        path(
          `/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/${NAMESPACE}/scripts/kvartal/secrets`,
        ),
        async ({ request }) => {
          captured.push({
            method: "PUT",
            path: "/scripts/kvartal/secrets",
            body: await captureBody(request),
          });
          return HttpResponse.json({ result: {}, success: true });
        },
      ),
    );
  }

  it("onProvision runs the full sequence: create D1 → migrate → upload script → set secrets", async () => {
    setupHappyPath();
    const provisioner = createCloudflareWfpD1Provisioner({
      accountId: ACCOUNT_ID,
      apiToken: "token",
      dispatchNamespace: NAMESPACE,
      controlPlaneBaseUrl: "https://auth.example.com",
      tenantWorkerScript:
        "export default { fetch() { return new Response('hi'); } };",
      migrations: [
        { name: "0000_init.sql", sql: "CREATE TABLE users (id TEXT);" },
        { name: "0001_add_keys.sql", sql: "CREATE TABLE keys (kid TEXT);" },
      ],
      secrets: async () => ({
        ENCRYPTION_KEY: "secret_value",
        ISSUER: "https://auth.example.com",
      }),
    });

    await provisioner.onProvision("kvartal");

    // Order: D1 create, then migrations reconciled against the tracking table
    // (create table, read applied set, then ONE call applying every pending
    // migration with its tracking row), then script upload and two secret puts.
    const paths = captured.map((c) => c.path);
    expect(paths).toEqual([
      "/d1/database",
      "/d1/exec", // CREATE TABLE _authhero_provisioner_migrations
      "/d1/exec", // SELECT applied migration names
      "/d1/exec", // 0000_init.sql + record, 0001_add_keys.sql + record
      "/scripts/kvartal",
      "/scripts/kvartal/secrets",
      "/scripts/kvartal/secrets",
    ]);

    // D1 is named per the default template
    expect((captured[0].body as { name: string }).name).toBe("tenant-kvartal");

    // Script binds the D1 by uuid + plain-text the control-plane URL
    const upload = captured.find((c) => c.path === "/scripts/kvartal");
    const metadata = JSON.parse(
      (upload!.body as Record<string, string>)["metadata"],
    );
    const dbBinding = metadata.bindings.find(
      (b: { name: string }) => b.name === "AUTH_DB",
    );
    const cpBinding = metadata.bindings.find(
      (b: { name: string }) => b.name === "CONTROL_PLANE_BASE_URL",
    );
    expect(dbBinding).toMatchObject({ type: "d1", id: "db_kvartal" });
    expect(cpBinding).toMatchObject({
      type: "plain_text",
      text: "https://auth.example.com",
    });

    // Secrets uploaded as secret_text
    const secretPuts = captured.filter(
      (c) => c.path === "/scripts/kvartal/secrets",
    );
    const secret1 = secretPuts[0].body as Record<string, string>;
    const secret2 = secretPuts[1].body as Record<string, string>;
    const names = [secret1.name, secret2.name].sort();
    expect(names).toEqual(["ENCRYPTION_KEY", "ISSUER"]);
    expect(secret1.type).toBe("secret_text");
  });

  it("appends extraBindings (e.g. a service binding) after the default bindings", async () => {
    setupHappyPath();
    const provisioner = createCloudflareWfpD1Provisioner({
      accountId: ACCOUNT_ID,
      apiToken: "token",
      dispatchNamespace: NAMESPACE,
      controlPlaneBaseUrl: "https://auth.example.com",
      tenantWorkerScript: "export default {};",
      migrations: [{ name: "0.sql", sql: "SELECT 1;" }],
      secrets: async () => ({ X: "y" }),
      extraBindings: [
        {
          type: "service",
          name: "JWKS_SERVICE",
          service: "control-plane-auth",
        },
        { type: "plain_text", name: "REGION", text: "eu" },
      ],
    });

    await provisioner.onProvision("kvartal");

    const upload = captured.find((c) => c.path === "/scripts/kvartal");
    const metadata = JSON.parse(
      (upload!.body as Record<string, string>)["metadata"],
    );
    const names = metadata.bindings.map((b: { name: string }) => b.name);
    // Defaults first, extras appended in order.
    expect(names).toEqual([
      "AUTH_DB",
      "CONTROL_PLANE_BASE_URL",
      "JWKS_SERVICE",
      "REGION",
    ]);
    expect(
      metadata.bindings.find(
        (b: { name: string }) => b.name === "JWKS_SERVICE",
      ),
    ).toEqual({
      type: "service",
      name: "JWKS_SERVICE",
      service: "control-plane-auth",
    });
  });

  it("forwards an analytics_engine extraBinding verbatim", async () => {
    setupHappyPath();
    const provisioner = createCloudflareWfpD1Provisioner({
      accountId: ACCOUNT_ID,
      apiToken: "token",
      dispatchNamespace: NAMESPACE,
      controlPlaneBaseUrl: "https://auth.example.com",
      tenantWorkerScript: "export default {};",
      migrations: [{ name: "0.sql", sql: "SELECT 1;" }],
      secrets: async () => ({ X: "y" }),
      extraBindings: [
        { type: "analytics_engine", name: "AUTH_LOGS", dataset: "auth_logs" },
      ],
    });

    await provisioner.onProvision("kvartal");

    const upload = captured.find((c) => c.path === "/scripts/kvartal");
    const metadata = JSON.parse(
      (upload!.body as Record<string, string>)["metadata"],
    );
    expect(
      metadata.bindings.find((b: { name: string }) => b.name === "AUTH_LOGS"),
    ).toEqual({
      type: "analytics_engine",
      name: "AUTH_LOGS",
      dataset: "auth_logs",
    });
  });

  it("re-provision heals an orphaned worker: reuses the existing D1, skips migrations, re-uploads the script", async () => {
    const warn = vi.fn();
    server.use(
      http.get(path(`/accounts/${ACCOUNT_ID}/d1/database`), () =>
        HttpResponse.json({
          result: [{ uuid: "db_existing", name: "tenant-kvartal" }],
          success: true,
        }),
      ),
      // Should NOT POST to create — fail if we do
      http.post(path(`/accounts/${ACCOUNT_ID}/d1/database`), () => {
        captured.push({ method: "POST", path: "/d1/database", body: {} });
        return HttpResponse.json({ result: {}, success: true });
      }),
      // Should NOT migrate an existing D1 — record it so we can assert it isn't.
      http.post(
        path(`/accounts/${ACCOUNT_ID}/d1/database/db_existing/query`),
        async ({ request }) => {
          captured.push({
            method: "POST",
            path: "/d1/exec",
            body: await captureBody(request),
          });
          return HttpResponse.json({
            result: [{ success: true }],
            success: true,
          });
        },
      ),
      http.put(
        path(
          `/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/${NAMESPACE}/scripts/kvartal`,
        ),
        async () => {
          captured.push({
            method: "PUT",
            path: "/scripts/kvartal",
            body: null,
          });
          return HttpResponse.json({ result: {}, success: true });
        },
      ),
      http.put(
        path(
          `/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/${NAMESPACE}/scripts/kvartal/secrets`,
        ),
        async () => HttpResponse.json({ result: {}, success: true }),
      ),
    );
    const provisioner = createCloudflareWfpD1Provisioner({
      accountId: ACCOUNT_ID,
      apiToken: "token",
      dispatchNamespace: NAMESPACE,
      controlPlaneBaseUrl: "https://auth.example.com",
      tenantWorkerScript: "export default {};",
      migrations: [{ name: "0000.sql", sql: "SELECT 1;" }],
      secrets: async () => ({ ENCRYPTION_KEY: "x" }),
      logger: { warn },
    });

    await provisioner.onProvision("kvartal");

    // No create (reused). The provisioner backfills its tracking table on a
    // legacy D1 (table-exists probe, CREATE TABLE, record), but — crucially —
    // never re-runs the migration SQL itself, which is what used to make a
    // re-provision throw on duplicate columns.
    expect(captured.filter((c) => c.path === "/d1/database")).toHaveLength(0);
    const migrationSql = captured
      .filter((c) => c.path === "/d1/exec")
      .map((c) => (c.body as { sql: string }).sql);
    expect(migrationSql.some((sql) => sql.includes("SELECT 1;"))).toBe(false);
    // The worker is still re-uploaded so the orphaned script is healed.
    expect(captured.find((c) => c.path === "/scripts/kvartal")).toBeDefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatch(/skipping migrations/);
  });

  it("onDeprovision deletes the namespaced script then the D1", async () => {
    server.use(
      http.delete(
        path(
          `/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/${NAMESPACE}/scripts/kvartal`,
        ),
        () => {
          captured.push({
            method: "DELETE",
            path: "/scripts/kvartal",
            body: null,
          });
          return HttpResponse.json({ result: null, success: true });
        },
      ),
      http.get(path(`/accounts/${ACCOUNT_ID}/d1/database`), () =>
        HttpResponse.json({
          result: [{ uuid: "db_kvartal", name: "tenant-kvartal" }],
          success: true,
        }),
      ),
      http.delete(
        path(`/accounts/${ACCOUNT_ID}/d1/database/db_kvartal`),
        () => {
          captured.push({
            method: "DELETE",
            path: "/d1/database/db_kvartal",
            body: null,
          });
          return HttpResponse.json({ result: null, success: true });
        },
      ),
    );
    const provisioner = createCloudflareWfpD1Provisioner({
      accountId: ACCOUNT_ID,
      apiToken: "token",
      dispatchNamespace: NAMESPACE,
      controlPlaneBaseUrl: "https://auth.example.com",
      tenantWorkerScript: "",
      migrations: [],
      secrets: async () => ({}),
    });

    await provisioner.onDeprovision("kvartal");

    expect(captured.map((c) => c.path)).toEqual([
      "/scripts/kvartal",
      "/d1/database/db_kvartal",
    ]);
  });

  it("onDeprovision tolerates missing script + missing D1 (idempotent)", async () => {
    server.use(
      http.delete(
        path(
          `/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/${NAMESPACE}/scripts/kvartal`,
        ),
        () =>
          HttpResponse.json(
            { errors: [{ message: "Script not found" }], success: false },
            { status: 404 },
          ),
      ),
      http.get(path(`/accounts/${ACCOUNT_ID}/d1/database`), () =>
        HttpResponse.json({ result: [], success: true }),
      ),
    );
    const provisioner = createCloudflareWfpD1Provisioner({
      accountId: ACCOUNT_ID,
      apiToken: "token",
      dispatchNamespace: NAMESPACE,
      controlPlaneBaseUrl: "https://auth.example.com",
      tenantWorkerScript: "",
      migrations: [],
      secrets: async () => ({}),
    });
    // Must not throw — both resources already gone.
    await provisioner.onDeprovision("kvartal");
  });

  it("onDeprovision still tears down the D1 even when the script delete fails, then throws an aggregate error", async () => {
    server.use(
      // Script delete fails with a non-404 — must NOT short-circuit the D1 teardown.
      http.delete(
        path(
          `/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/${NAMESPACE}/scripts/kvartal`,
        ),
        () =>
          HttpResponse.json(
            { errors: [{ message: "internal error" }], success: false },
            { status: 500 },
          ),
      ),
      http.get(path(`/accounts/${ACCOUNT_ID}/d1/database`), () =>
        HttpResponse.json({
          result: [{ uuid: "db_kvartal", name: "tenant-kvartal" }],
          success: true,
        }),
      ),
      http.delete(
        path(`/accounts/${ACCOUNT_ID}/d1/database/db_kvartal`),
        () => {
          captured.push({
            method: "DELETE",
            path: "/d1/database/db_kvartal",
            body: null,
          });
          return HttpResponse.json({ result: null, success: true });
        },
      ),
    );
    const provisioner = createCloudflareWfpD1Provisioner({
      accountId: ACCOUNT_ID,
      apiToken: "token",
      dispatchNamespace: NAMESPACE,
      controlPlaneBaseUrl: "https://auth.example.com",
      tenantWorkerScript: "",
      migrations: [],
      secrets: async () => ({}),
    });

    await expect(provisioner.onDeprovision("kvartal")).rejects.toThrow(
      /had 1 failure/,
    );
    // The D1 deletion was still attempted despite the script-delete failure.
    expect(
      captured.find((c) => c.path === "/d1/database/db_kvartal"),
    ).toBeDefined();
  });

  it("script and D1 names honor the template option", async () => {
    server.use(
      http.get(path(`/accounts/${ACCOUNT_ID}/d1/database`), () =>
        HttpResponse.json({ result: [], success: true }),
      ),
      http.post(
        path(`/accounts/${ACCOUNT_ID}/d1/database`),
        async ({ request }) => {
          captured.push({
            method: "POST",
            path: "/d1/database",
            body: await captureBody(request),
          });
          return HttpResponse.json({
            result: { uuid: "db_x", name: "authhero-tenant-kvartal" },
            success: true,
          });
        },
      ),
      http.post(path(`/accounts/${ACCOUNT_ID}/d1/database/db_x/query`), () =>
        HttpResponse.json({ result: [{ success: true }], success: true }),
      ),
      http.put(
        path(
          `/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/${NAMESPACE}/scripts/tenant-kvartal-auth`,
        ),
        () => {
          captured.push({
            method: "PUT",
            path: "/scripts/tenant-kvartal-auth",
            body: null,
          });
          return HttpResponse.json({ result: {}, success: true });
        },
      ),
      http.put(
        path(
          `/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/${NAMESPACE}/scripts/tenant-kvartal-auth/secrets`,
        ),
        () => HttpResponse.json({ result: {}, success: true }),
      ),
    );
    const provisioner = createCloudflareWfpD1Provisioner({
      accountId: ACCOUNT_ID,
      apiToken: "token",
      dispatchNamespace: NAMESPACE,
      controlPlaneBaseUrl: "https://auth.example.com",
      tenantWorkerScript: "",
      migrations: [{ name: "0.sql", sql: "SELECT 1;" }],
      secrets: async () => ({ X: "y" }),
      scriptNameTemplate: "tenant-{tenant_id}-auth",
      d1NameTemplate: "authhero-tenant-{tenant_id}",
    });
    await provisioner.onProvision("kvartal");
    expect((captured[0].body as { name: string }).name).toBe(
      "authhero-tenant-kvartal",
    );
    expect(
      captured.find((c) => c.path === "/scripts/tenant-kvartal-auth"),
    ).toBeDefined();
  });

  it("onProvision returns the resource ids the caller needs to persist", async () => {
    setupHappyPath();
    const provisioner = createCloudflareWfpD1Provisioner({
      accountId: ACCOUNT_ID,
      apiToken: "token",
      dispatchNamespace: NAMESPACE,
      controlPlaneBaseUrl: "https://auth.example.com",
      tenantWorkerScript: "",
      migrations: [{ name: "0.sql", sql: "SELECT 1;" }],
      secrets: async () => ({ X: "y" }),
    });
    const result = await provisioner.onProvision("kvartal");
    expect(result).toEqual({
      d1DatabaseId: "db_kvartal",
      scriptName: "kvartal",
      d1Name: "tenant-kvartal",
      // database_version is the last migration; no bundle/worker version set
      databaseVersion: "0.sql",
    });
  });

  it("onProvision reports the deployed versions: bundle, worker, and the latest migration as database_version", async () => {
    setupHappyPath();
    const provisioner = createCloudflareWfpD1Provisioner({
      accountId: ACCOUNT_ID,
      apiToken: "token",
      dispatchNamespace: NAMESPACE,
      controlPlaneBaseUrl: "https://auth.example.com",
      tenantWorkerScript: "",
      bundleConfiguration: "authhero-drizzle-d1",
      workerVersion: "v1.2.3",
      migrations: [
        { name: "0000_init.sql", sql: "SELECT 1;" },
        { name: "0001_add_x.sql", sql: "SELECT 1;" },
      ],
      secrets: async () => ({ X: "y" }),
    });
    const result = await provisioner.onProvision("kvartal");
    expect(result.bundleConfiguration).toBe("authhero-drizzle-d1");
    expect(result.workerVersion).toBe("v1.2.3");
    expect(result.databaseVersion).toBe("0001_add_x.sql");
  });

  it("onProvision leaves database_version undefined when no migrations are configured", async () => {
    setupHappyPath();
    const provisioner = createCloudflareWfpD1Provisioner({
      accountId: ACCOUNT_ID,
      apiToken: "token",
      dispatchNamespace: NAMESPACE,
      controlPlaneBaseUrl: "https://auth.example.com",
      tenantWorkerScript: "",
      migrations: [],
      secrets: async () => ({ X: "y" }),
    });
    const result = await provisioner.onProvision("kvartal");
    expect(result.databaseVersion).toBeUndefined();
  });
});

describe("WFP provisioner migration batching", () => {
  const DB = "db_batch";
  const TRACKING_INSERT =
    /INSERT OR IGNORE INTO _authhero_provisioner_migrations \(name, applied_at\) VALUES \('([^']+)'/g;

  /**
   * A fake D1 `/query` endpoint that keeps the tracking table's state.
   * A body containing `failOn` fails. In "atomic" mode nothing from the
   * failing body persists (whole-batch rollback); in "stop-at-error" mode
   * the tracking rows before the failing statement persist.
   */
  function setupD1(opts: {
    created: boolean;
    tracked?: string[];
    failOn?: string;
    mode?: "atomic" | "stop-at-error";
  }): { queries: string[]; tracked: Set<string> } {
    const queries: string[] = [];
    const tracked = new Set(opts.tracked ?? []);
    server.use(
      http.get(path(`/accounts/${ACCOUNT_ID}/d1/database`), () =>
        HttpResponse.json({
          result: opts.created ? [] : [{ uuid: DB, name: "tenant-kvartal" }],
          success: true,
        }),
      ),
      http.post(path(`/accounts/${ACCOUNT_ID}/d1/database`), () =>
        HttpResponse.json({
          result: { uuid: DB, name: "tenant-kvartal" },
          success: true,
        }),
      ),
      http.post(
        path(`/accounts/${ACCOUNT_ID}/d1/database/${DB}/query`),
        async ({ request }) => {
          const { sql } = (await request.json()) as { sql: string };
          queries.push(sql);
          if (sql.startsWith("SELECT name FROM sqlite_master")) {
            return HttpResponse.json({
              result: [
                { results: [{ name: "_authhero_provisioner_migrations" }] },
              ],
              success: true,
            });
          }
          if (sql.startsWith("SELECT name FROM _authhero")) {
            return HttpResponse.json({
              result: [{ results: [...tracked].map((name) => ({ name })) }],
              success: true,
            });
          }
          const failAt =
            opts.failOn !== undefined ? sql.indexOf(opts.failOn) : -1;
          if (failAt === -1 || opts.mode === "stop-at-error") {
            const upTo = failAt === -1 ? sql : sql.slice(0, failAt);
            for (const m of upTo.matchAll(TRACKING_INSERT)) tracked.add(m[1]!);
          }
          if (failAt !== -1) {
            return HttpResponse.json(
              {
                success: false,
                errors: [{ code: 7500, message: "near BOOM: syntax error" }],
              },
              { status: 400 },
            );
          }
          return HttpResponse.json({
            result: [{ results: [] }],
            success: true,
          });
        },
      ),
      http.put(
        path(
          `/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/${NAMESPACE}/scripts/kvartal`,
        ),
        () => HttpResponse.json({ result: {}, success: true }),
      ),
      http.put(
        path(
          `/accounts/${ACCOUNT_ID}/workers/dispatch/namespaces/${NAMESPACE}/scripts/kvartal/secrets`,
        ),
        () => HttpResponse.json({ result: {}, success: true }),
      ),
    );
    return { queries, tracked };
  }

  function provisioner(migrations: { name: string; sql: string }[]) {
    return createCloudflareWfpD1Provisioner({
      accountId: ACCOUNT_ID,
      apiToken: "token",
      dispatchNamespace: NAMESPACE,
      controlPlaneBaseUrl: "https://auth.example.com",
      tenantWorkerScript: "",
      migrations,
      secrets: async () => ({}),
    });
  }

  const nineteen = Array.from({ length: 19 }, (_, i) => ({
    name: `${String(i).padStart(4, "0")}_m.sql`,
    sql: `CREATE TABLE t${i} (id TEXT);`,
  }));

  it("applies all pending migrations of a fresh D1 in one call, each followed by its tracking row", async () => {
    const d1 = setupD1({ created: true });
    await provisioner(nineteen).onProvision("kvartal");

    // CREATE TABLE tracking, SELECT applied, one apply call.
    expect(d1.queries).toHaveLength(3);
    const apply = d1.queries[2]!;
    let cursor = 0;
    for (const m of nineteen) {
      const sqlAt = apply.indexOf(m.sql, cursor);
      const rowAt = apply.indexOf(`VALUES ('${m.name}'`, cursor);
      expect(sqlAt).toBeGreaterThanOrEqual(cursor);
      expect(rowAt).toBeGreaterThan(sqlAt);
      cursor = rowAt;
    }
    expect([...d1.tracked].sort()).toEqual(nineteen.map((m) => m.name));
  });

  it("only includes untracked migrations", async () => {
    const d1 = setupD1({
      created: false,
      tracked: ["0000_m.sql", "0001_m.sql"],
    });
    await provisioner(nineteen.slice(0, 4)).onProvision("kvartal");

    // table-exists probe, CREATE TABLE IF NOT EXISTS, SELECT applied, apply.
    expect(d1.queries).toHaveLength(4);
    const apply = d1.queries[3]!;
    expect(apply).not.toContain("t0 (");
    expect(apply).not.toContain("t1 (");
    expect(apply).toContain("CREATE TABLE t2 (id TEXT);");
    expect(apply).toContain("CREATE TABLE t3 (id TEXT);");
    expect(apply).not.toContain("'0000_m.sql'");
    expect(apply).not.toContain("'0001_m.sql'");
  });

  it("makes no apply call when nothing is pending", async () => {
    const d1 = setupD1({
      created: false,
      tracked: nineteen.slice(0, 3).map((m) => m.name),
    });
    await provisioner(nineteen.slice(0, 3)).onProvision("kvartal");
    // table-exists probe, CREATE TABLE IF NOT EXISTS, SELECT applied.
    expect(d1.queries).toHaveLength(3);
    expect(d1.queries.some((q) => q.includes("INSERT"))).toBe(false);
  });

  for (const mode of ["atomic", "stop-at-error"] as const) {
    it(`a failed combined call still names the failing migration (${mode})`, async () => {
      const migrations = [
        { name: "0000_a.sql", sql: "CREATE TABLE a (id TEXT);" },
        { name: "0001_bad.sql", sql: "BOOM;" },
        { name: "0002_c.sql", sql: "CREATE TABLE c (id TEXT);" },
      ];
      const d1 = setupD1({ created: true, failOn: "BOOM", mode });
      await expect(
        provisioner(migrations).onProvision("kvartal"),
      ).rejects.toThrow(
        /Failed to apply migration "0001_bad\.sql" to D1 db_batch: .*BOOM/,
      );
      // The migration before the failure is tracked; the failing one and the
      // one after it are not, so a retry resumes at 0001_bad.sql.
      expect([...d1.tracked]).toEqual(["0000_a.sql"]);
      // Never re-ran 0002 after 0001 failed.
      const last = d1.queries[d1.queries.length - 1]!;
      expect(last).toContain("BOOM;");
      expect(last).not.toContain("CREATE TABLE c");
    });
  }

  it("splits SQL over the size threshold into several calls without splitting a migration", async () => {
    // ~40 KB each: three of them cannot share one 90 KB request.
    const big = (i: number) => ({
      name: `000${i}_big.sql`,
      sql: `INSERT INTO t VALUES ('${"x".repeat(40_000)}');`,
    });
    const migrations = [big(0), big(1), big(2), big(3)];
    const d1 = setupD1({ created: true });
    await provisioner(migrations).onProvision("kvartal");

    const applies = d1.queries.slice(2);
    expect(applies).toHaveLength(2);
    for (const q of applies) {
      expect(new TextEncoder().encode(q).length).toBeLessThanOrEqual(
        MAX_MIGRATION_BATCH_BYTES,
      );
      // Every migration body in a request is followed by its own tracking row.
      const bodies = q.match(/INSERT INTO t VALUES/g)?.length ?? 0;
      const rows = [...q.matchAll(TRACKING_INSERT)].length;
      expect(rows).toBe(bodies);
    }
    expect([...d1.tracked].sort()).toEqual(migrations.map((m) => m.name));
  });
});

describe("terminateSqlForConcat", () => {
  it("keeps a statement that already ends with ';'", () => {
    expect(terminateSqlForConcat("SELECT 1;")).toBe("SELECT 1;\n");
  });

  it("adds a ';' to an unterminated final statement", () => {
    expect(terminateSqlForConcat("SELECT 1")).toBe("SELECT 1\n;\n");
  });

  it("ends a trailing line comment so it cannot swallow what follows", () => {
    const out = terminateSqlForConcat("SELECT 1; -- done");
    expect(out).toBe("SELECT 1; -- done\n");
    const out2 = terminateSqlForConcat("SELECT 1 -- no semicolon");
    expect(out2).toBe("SELECT 1 -- no semicolon\n;\n");
  });

  it("closes an unterminated block comment", () => {
    expect(terminateSqlForConcat("SELECT 1; /* open")).toBe(
      "SELECT 1; /* open\n*/\n",
    );
  });

  it("ignores ';' and '--' inside string literals", () => {
    expect(terminateSqlForConcat("INSERT INTO t VALUES ('a;')")).toBe(
      "INSERT INTO t VALUES ('a;')\n;\n",
    );
    expect(terminateSqlForConcat("INSERT INTO t VALUES ('it''s -- ok');")).toBe(
      "INSERT INTO t VALUES ('it''s -- ok');\n",
    );
  });

  it("leaves comment-only SQL without adding an empty statement", () => {
    expect(terminateSqlForConcat("-- nothing here")).toBe("-- nothing here\n");
  });
});

describe("chunkMigrationParts", () => {
  it("keeps whole parts together and never splits one", () => {
    const parts = [
      { sql: "a".repeat(50) },
      { sql: "b".repeat(50) },
      { sql: "c".repeat(200) },
      { sql: "d".repeat(10) },
    ];
    expect(chunkMigrationParts(parts, 100)).toEqual([
      [parts[0], parts[1]],
      [parts[2]],
      [parts[3]],
    ]);
  });
});

// ─── createWfpTenantProvisioningHook ────────────────────────────────────

describe("createWfpTenantProvisioningHook", () => {
  function fakeProvisioner(): CloudflareWfpD1Provisioner & {
    onProvisionCalls: string[];
    onDeprovisionCalls: string[];
    nextProvisionResult: ProvisionResult;
    nextProvisionError?: Error;
  } {
    const stub = {
      onProvisionCalls: [] as string[],
      onDeprovisionCalls: [] as string[],
      nextProvisionResult: {
        d1DatabaseId: "db_x",
        scriptName: "kvartal",
        d1Name: "tenant-kvartal",
      } satisfies ProvisionResult,
      nextProvisionError: undefined as Error | undefined,
      async onProvision(id: string): Promise<ProvisionResult> {
        stub.onProvisionCalls.push(id);
        if (stub.nextProvisionError) throw stub.nextProvisionError;
        return stub.nextProvisionResult;
      },
      async onDeprovision(id: string): Promise<void> {
        stub.onDeprovisionCalls.push(id);
      },
    };
    return stub;
  }

  function fakeTenantsAdapter(
    initial: Partial<Tenant> & { id: string },
  ): TenantsDataAdapter & { store: Map<string, Partial<Tenant>> } {
    const store = new Map<string, Partial<Tenant>>([[initial.id, initial]]);
    return {
      store,
      async create(): Promise<Tenant> {
        throw new Error("not used in tests");
      },
      async get(id: string): Promise<Tenant | null> {
        return (store.get(id) as Tenant | undefined) ?? null;
      },
      async list() {
        return { tenants: Array.from(store.values()) as Tenant[] };
      },
      async update(id: string, patch: Partial<Tenant>): Promise<void> {
        const cur = store.get(id);
        if (!cur) return;
        store.set(id, { ...cur, ...patch });
      },
      async remove(id: string): Promise<boolean> {
        return store.delete(id);
      },
    };
  }

  it("skips provisioning when deployment_type is not 'wfp'", async () => {
    const provisioner = fakeProvisioner();
    const tenants = fakeTenantsAdapter({
      id: "shared-tenant",
      deployment_type: "shared",
    });
    const hook = createWfpTenantProvisioningHook({ provisioner, tenants });
    await hook.onProvision("shared-tenant");
    expect(provisioner.onProvisionCalls).toEqual([]);
    expect(tenants.store.get("shared-tenant")).toMatchObject({
      deployment_type: "shared",
    });
  });

  it("provisions and writes back resource ids when deployment_type is 'wfp'", async () => {
    const provisioner = fakeProvisioner();
    provisioner.nextProvisionResult = {
      d1DatabaseId: "db_kvartal",
      scriptName: "kvartal",
      d1Name: "tenant-kvartal",
    };
    const tenants = fakeTenantsAdapter({
      id: "kvartal",
      deployment_type: "wfp",
      provisioning_state: "pending",
    });
    const hook = createWfpTenantProvisioningHook({ provisioner, tenants });
    await hook.onProvision("kvartal");
    expect(provisioner.onProvisionCalls).toEqual(["kvartal"]);
    const row = tenants.store.get("kvartal");
    expect(row).toMatchObject({
      d1_database_id: "db_kvartal",
      worker_script_name: "kvartal",
      provisioning_state: "ready",
    });
    expect(row?.provisioning_state_changed_at).toMatch(/^\d{4}-/);
  });

  it("runs syncDefaults after provisioning and before marking ready", async () => {
    const provisioner = fakeProvisioner();
    provisioner.nextProvisionResult = {
      d1DatabaseId: "db_kvartal",
      scriptName: "kvartal",
      d1Name: "tenant-kvartal",
    };
    const tenants = fakeTenantsAdapter({
      id: "kvartal",
      deployment_type: "wfp",
      provisioning_state: "pending",
    });
    const order: string[] = [];
    const syncDefaults = vi.fn(async (id: string) => {
      // At seed time the resources exist but the tenant isn't ready yet.
      order.push(`sync:${id}`);
      expect(tenants.store.get("kvartal")?.provisioning_state).not.toBe(
        "ready",
      );
    });
    const hook = createWfpTenantProvisioningHook({
      provisioner,
      tenants,
      syncDefaults,
    });
    await hook.onProvision("kvartal");
    expect(syncDefaults).toHaveBeenCalledWith("kvartal");
    expect(order).toEqual(["sync:kvartal"]);
    expect(tenants.store.get("kvartal")).toMatchObject({
      d1_database_id: "db_kvartal",
      provisioning_state: "ready",
    });
  });

  it("marks failed (but persists resource ids) when the post-provision syncDefaults throws", async () => {
    const provisioner = fakeProvisioner();
    provisioner.nextProvisionResult = {
      d1DatabaseId: "db_kvartal",
      scriptName: "kvartal",
      d1Name: "tenant-kvartal",
    };
    const tenants = fakeTenantsAdapter({
      id: "kvartal",
      deployment_type: "wfp",
      provisioning_state: "pending",
    });
    const hook = createWfpTenantProvisioningHook({
      provisioner,
      tenants,
      syncDefaults: async () => {
        throw new Error("sync push 500");
      },
    });
    await expect(hook.onProvision("kvartal")).rejects.toThrow(/sync push 500/);
    const row = tenants.store.get("kvartal");
    // No "ready over an empty D1": state is failed with the cause...
    expect(row).toMatchObject({
      provisioning_state: "failed",
      provisioning_error: "sync push 500",
    });
    // ...but the resource ids are still persisted so a re-provision can heal it.
    expect(row?.d1_database_id).toBe("db_kvartal");
    expect(row?.worker_script_name).toBe("kvartal");
  });

  it("marks provisioning_state='failed' with the error message when the provisioner throws", async () => {
    const provisioner = fakeProvisioner();
    provisioner.nextProvisionError = new Error("D1 quota exceeded");
    const tenants = fakeTenantsAdapter({
      id: "kvartal",
      deployment_type: "wfp",
      provisioning_state: "pending",
    });
    const hook = createWfpTenantProvisioningHook({ provisioner, tenants });
    await expect(hook.onProvision("kvartal")).rejects.toThrow(
      /D1 quota exceeded/,
    );
    const row = tenants.store.get("kvartal");
    expect(row).toMatchObject({
      provisioning_state: "failed",
      provisioning_error: "D1 quota exceeded",
    });
    // d1_database_id should NOT be set on failure
    expect(row?.d1_database_id).toBeUndefined();
  });

  it("uses the shouldProvision predicate when supplied", async () => {
    const provisioner = fakeProvisioner();
    const tenants = fakeTenantsAdapter({
      id: "kvartal",
      deployment_type: "shared",
      storage_kind: "own_d1",
    });
    const hook = createWfpTenantProvisioningHook({
      provisioner,
      tenants,
      // Custom signal: provision whenever storage_kind says own_d1, regardless
      // of deployment_type (illustrative — not a recommended config).
      shouldProvision: (t) => t.storage_kind === "own_d1",
    });
    await hook.onProvision("kvartal");
    expect(provisioner.onProvisionCalls).toEqual(["kvartal"]);
  });

  it("onDeprovision skips when the tenant was 'shared'", async () => {
    const provisioner = fakeProvisioner();
    const tenants = fakeTenantsAdapter({
      id: "kvartal",
      deployment_type: "shared",
    });
    const hook = createWfpTenantProvisioningHook({ provisioner, tenants });
    await hook.onDeprovision("kvartal");
    expect(provisioner.onDeprovisionCalls).toEqual([]);
  });

  it("onDeprovision defaults to running when the tenant row is already gone", async () => {
    // Sometimes the multi-tenancy delete cascades before this hook runs. In
    // that case we don't know what type the tenant was — better to attempt
    // deprovision than leave CF resources orphaned.
    const provisioner = fakeProvisioner();
    const tenants = fakeTenantsAdapter({
      id: "other",
      deployment_type: "shared",
    });
    const hook = createWfpTenantProvisioningHook({ provisioner, tenants });
    await hook.onDeprovision("kvartal-already-deleted");
    expect(provisioner.onDeprovisionCalls).toEqual(["kvartal-already-deleted"]);
  });

  it("logs a warning when the write-back fails after a successful provision", async () => {
    const provisioner = fakeProvisioner();
    provisioner.nextProvisionError = new Error("upstream failed");
    const tenants: TenantsDataAdapter = {
      async create() {
        throw new Error("not used");
      },
      async get() {
        return {
          id: "kvartal",
          friendly_name: "Kvartal",
          deployment_type: "wfp",
        } as Tenant;
      },
      async list() {
        return { tenants: [] };
      },
      async update() {
        throw new Error("write-back DB outage");
      },
      async remove() {
        return false;
      },
    };
    const warn = vi.fn();
    const hook = createWfpTenantProvisioningHook({
      provisioner,
      tenants,
      logger: { warn },
    });
    await expect(hook.onProvision("kvartal")).rejects.toThrow(
      /upstream failed/,
    );
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatch(/Failed to write provisioning_state/);
  });

  it("writes the deployed versions back onto the tenant row", async () => {
    const provisioner = fakeProvisioner();
    provisioner.nextProvisionResult = {
      d1DatabaseId: "db_kvartal",
      scriptName: "kvartal",
      d1Name: "tenant-kvartal",
      bundleConfiguration: "authhero-drizzle-d1",
      workerVersion: "v1.2.3",
      databaseVersion: "0001_add_x.sql",
    };
    const tenants = fakeTenantsAdapter({
      id: "kvartal",
      deployment_type: "wfp",
      provisioning_state: "pending",
    });
    const hook = createWfpTenantProvisioningHook({ provisioner, tenants });
    await hook.onProvision("kvartal");
    expect(tenants.store.get("kvartal")).toMatchObject({
      bundle_configuration: "authhero-drizzle-d1",
      worker_version: "v1.2.3",
      database_version: "0001_add_x.sql",
      provisioning_state: "ready",
    });
  });

  it("onUpgrade re-provisions a wfp tenant and rewrites its versions", async () => {
    const provisioner = fakeProvisioner();
    provisioner.nextProvisionResult = {
      d1DatabaseId: "db_kvartal",
      scriptName: "kvartal",
      d1Name: "tenant-kvartal",
      bundleConfiguration: "authhero-drizzle-d1",
      workerVersion: "v2.0.0",
      databaseVersion: "0002_add_y.sql",
    };
    const tenants = fakeTenantsAdapter({
      id: "kvartal",
      deployment_type: "wfp",
      provisioning_state: "ready",
      worker_version: "v1.0.0",
      database_version: "0001_add_x.sql",
    });
    const hook = createWfpTenantProvisioningHook({ provisioner, tenants });
    await hook.onUpgrade("kvartal");
    expect(provisioner.onProvisionCalls).toEqual(["kvartal"]);
    expect(tenants.store.get("kvartal")).toMatchObject({
      worker_version: "v2.0.0",
      database_version: "0002_add_y.sql",
      provisioning_state: "ready",
    });
  });

  it("onUpgrade marks the tenant 'pending' before re-provisioning", async () => {
    const provisioner = fakeProvisioner();
    const tenants = fakeTenantsAdapter({
      id: "kvartal",
      deployment_type: "wfp",
      provisioning_state: "ready",
    });
    // Observe the state at the moment the provisioner runs.
    let stateDuringProvision: string | undefined;
    const baseOnProvision = provisioner.onProvision.bind(provisioner);
    provisioner.onProvision = async (id: string) => {
      stateDuringProvision = tenants.store.get(id)?.provisioning_state;
      return baseOnProvision(id);
    };
    const hook = createWfpTenantProvisioningHook({ provisioner, tenants });
    await hook.onUpgrade("kvartal");
    expect(stateDuringProvision).toBe("pending");
  });

  it("onUpgrade marks failed and rethrows when the provisioner throws", async () => {
    const provisioner = fakeProvisioner();
    provisioner.nextProvisionError = new Error("upload failed");
    const tenants = fakeTenantsAdapter({
      id: "kvartal",
      deployment_type: "wfp",
      provisioning_state: "ready",
    });
    const hook = createWfpTenantProvisioningHook({ provisioner, tenants });
    await expect(hook.onUpgrade("kvartal")).rejects.toThrow(/upload failed/);
    expect(tenants.store.get("kvartal")).toMatchObject({
      provisioning_state: "failed",
      provisioning_error: "upload failed",
    });
  });

  it("onUpgrade throws for a missing tenant", async () => {
    const provisioner = fakeProvisioner();
    const tenants = fakeTenantsAdapter({ id: "other", deployment_type: "wfp" });
    const hook = createWfpTenantProvisioningHook({ provisioner, tenants });
    await expect(hook.onUpgrade("missing")).rejects.toThrow(/not found/);
    expect(provisioner.onProvisionCalls).toEqual([]);
  });

  it("onUpgrade throws for a non-wfp tenant", async () => {
    const provisioner = fakeProvisioner();
    const tenants = fakeTenantsAdapter({
      id: "shared-tenant",
      deployment_type: "shared",
    });
    const hook = createWfpTenantProvisioningHook({ provisioner, tenants });
    await expect(hook.onUpgrade("shared-tenant")).rejects.toThrow(
      /not a WFP-provisioned tenant/,
    );
    expect(provisioner.onProvisionCalls).toEqual([]);
  });
});

// ─── provisioning step reporter (issue #1026) ───────────────────────────

describe("createWfpTenantProvisioningHook step reporter", () => {
  function reporterFakes(withSeed: boolean) {
    const provisioner: CloudflareWfpD1Provisioner & {
      nextProvisionError?: Error;
    } = {
      nextProvisionError: undefined,
      async onProvision(): Promise<ProvisionResult> {
        if (provisioner.nextProvisionError)
          throw provisioner.nextProvisionError;
        return {
          d1DatabaseId: "db_x",
          scriptName: "kvartal",
          d1Name: "tenant-kvartal",
        };
      },
      async onDeprovision(): Promise<void> {},
    };
    const store = new Map<string, Partial<Tenant>>([
      ["kvartal", { id: "kvartal", deployment_type: "wfp" }],
    ]);
    const tenants: TenantsDataAdapter = {
      async create(): Promise<Tenant> {
        throw new Error("not used");
      },
      async get(id: string): Promise<Tenant | null> {
        return (store.get(id) as Tenant | undefined) ?? null;
      },
      async list() {
        return { tenants: Array.from(store.values()) as Tenant[] };
      },
      async update(id: string, patch: Partial<Tenant>): Promise<void> {
        const cur = store.get(id);
        if (cur) store.set(id, { ...cur, ...patch });
      },
      async remove(id: string): Promise<boolean> {
        return store.delete(id);
      },
    };
    const syncDefaults = withSeed ? async () => ({}) : undefined;
    return { provisioner, tenants, store, syncDefaults };
  }

  it("reports provision-resources and seed-defaults boundaries", async () => {
    const { provisioner, tenants, syncDefaults } = reporterFakes(true);
    const hook = createWfpTenantProvisioningHook({
      provisioner,
      tenants,
      syncDefaults,
    });

    const reported: string[] = [];
    await hook.onProvision("kvartal", async (step, outcome, detail) => {
      reported.push(`${step}:${outcome}`);
      if (step === "provision-resources" && outcome === "succeeded") {
        expect(detail).toMatchObject({ d1_database_id: "db_x" });
      }
    });

    expect(reported).toEqual([
      "provision-resources:started",
      "provision-resources:succeeded",
      "seed-defaults:started",
      "seed-defaults:succeeded",
    ]);
  });

  it("reports a failed provision step and still marks the tenant failed", async () => {
    const { provisioner, tenants, store } = reporterFakes(false);
    provisioner.nextProvisionError = new Error("cf exploded");
    const hook = createWfpTenantProvisioningHook({ provisioner, tenants });

    const reported: string[] = [];
    await expect(
      hook.onProvision("kvartal", async (step, outcome) => {
        reported.push(`${step}:${outcome}`);
      }),
    ).rejects.toThrow("cf exploded");

    expect(reported).toEqual([
      "provision-resources:started",
      "provision-resources:failed",
    ]);
    expect(store.get("kvartal")).toMatchObject({
      provisioning_state: "failed",
    });
  });

  it("reports the same step boundaries during an upgrade", async () => {
    const { provisioner, tenants, store, syncDefaults } = reporterFakes(true);
    const hook = createWfpTenantProvisioningHook({
      provisioner,
      tenants,
      syncDefaults,
    });

    const reported: string[] = [];
    await hook.onUpgrade("kvartal", async (step, outcome) => {
      reported.push(`${step}:${outcome}`);
    });

    expect(reported).toEqual([
      "provision-resources:started",
      "provision-resources:succeeded",
      "seed-defaults:started",
      "seed-defaults:succeeded",
    ]);
    expect(store.get("kvartal")).toMatchObject({
      provisioning_state: "ready",
    });
  });

  it("reports seed-defaults as failed when the seed collects errors", async () => {
    const { provisioner, tenants, store } = reporterFakes(false);
    const hook = createWfpTenantProvisioningHook({
      provisioner,
      tenants,
      // Resolves cleanly but carries per-entity errors (continueOnError).
      syncDefaults: async () => ({
        connections: { errors: ["insert failed"] },
      }),
    });

    const reported: string[] = [];
    await expect(
      hook.onProvision("kvartal", async (step, outcome) => {
        reported.push(`${step}:${outcome}`);
      }),
    ).rejects.toThrow(/sync-defaults seed reported 1 error/);

    expect(reported).toEqual([
      "provision-resources:started",
      "provision-resources:succeeded",
      "seed-defaults:started",
      "seed-defaults:failed",
    ]);
    expect(store.get("kvartal")).toMatchObject({
      provisioning_state: "failed",
      // Resource ids survive the failure so a re-provision can find them.
      d1_database_id: "db_x",
    });
  });

  it("never lets a throwing reporter fail the provision", async () => {
    const { provisioner, tenants, store, syncDefaults } = reporterFakes(true);
    const hook = createWfpTenantProvisioningHook({
      provisioner,
      tenants,
      syncDefaults,
    });

    await hook.onProvision("kvartal", async () => {
      throw new Error("reporter down");
    });

    expect(store.get("kvartal")).toMatchObject({
      provisioning_state: "ready",
    });
  });
});
