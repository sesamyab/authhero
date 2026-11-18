import { describe, it, expect } from "vitest";
import type { StorageAdapter } from "@authhero/adapter-interfaces";
import { getAdminToken } from "../helpers/token";
import { getTestServer } from "../helpers/test-server";

function memoryStorage(publicBaseUrl?: string) {
  const store = new Map<string, { data: Uint8Array; contentType: string }>();
  const adapter: StorageAdapter = {
    async put(key, body, options) {
      store.set(key, {
        data: body instanceof Uint8Array ? body : new Uint8Array(body),
        contentType: options.contentType,
      });
    },
    async get(key) {
      const o = store.get(key);
      if (!o) return null;
      return {
        body: new Response(o.data).body!,
        contentType: o.contentType,
        size: o.data.byteLength,
      };
    },
    async delete(key) {
      store.delete(key);
    },
    getPublicUrl: (key) =>
      publicBaseUrl ? `${publicBaseUrl}/${key}` : undefined,
  };
  return { adapter, store };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);

async function upload(
  server: Awaited<ReturnType<typeof getTestServer>>,
  kind: string,
  file: File | string,
  tenant = "tenantId",
) {
  const token = await getAdminToken();
  const form = new FormData();
  form.set("file", file);
  return server.app.request(
    `/api/v2/branding/uploads/${kind}`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "tenant-id": tenant },
      body: form,
    },
    server.env,
  );
}

describe("POST /branding/uploads/{kind}", () => {
  it("returns 501 without a storage adapter", async () => {
    const server = await getTestServer();
    const res = await upload(
      server,
      "logo",
      new File([PNG], "a.png", { type: "image/png" }),
    );
    expect(res.status).toBe(501);
  });

  it("stores under the tenant prefix and serves it through /assets", async () => {
    const { adapter, store } = memoryStorage();
    const server = await getTestServer({
      wrapDataAdapter: (d) => ({ ...d, storage: adapter }),
    });
    const res = await upload(
      server,
      "logo",
      new File([PNG], "a.png", { type: "image/png" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.key).toMatch(/^tenants\/tenantId\/branding\/logo\/.+\.png$/);
    expect(body.url).toBe(`${server.env.ISSUER}assets/${body.key}`);
    expect(store.has(body.key)).toBe(true);

    const served = await server.app.request(
      `/assets/${body.key}`,
      {},
      server.env,
    );
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("cache-control")).toContain("immutable");
    expect(served.headers.get("access-control-allow-origin")).toBe("*");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(PNG);
  });

  it("uses the public base URL when the adapter has one", async () => {
    const { adapter } = memoryStorage("https://assets.example.com");
    const server = await getTestServer({
      wrapDataAdapter: (d) => ({ ...d, storage: adapter }),
    });
    const res = await upload(
      server,
      "favicon",
      new File([PNG], "a.png", { type: "image/png" }),
    );
    const body = (await res.json()) as any;
    expect(body.url).toBe(`https://assets.example.com/${body.key}`);
  });

  it("rejects bad type, mismatched content, oversize and unsafe SVG", async () => {
    const { adapter, store } = memoryStorage();
    const server = await getTestServer({
      wrapDataAdapter: (d) => ({ ...d, storage: adapter }),
    });
    const bad = [
      ["logo", new File(["hi"], "a.txt", { type: "text/plain" })],
      ["logo", new File(["not a png"], "a.png", { type: "image/png" })],
      [
        "logo",
        new File([new Uint8Array(2 * 1024 * 1024 + 1)], "a.png", {
          type: "image/png",
        }),
      ],
      ["font", new File([PNG], "a.png", { type: "image/png" })],
      [
        "logo",
        new File(['<svg xmlns="x"><script>alert(1)</script></svg>'], "a.svg", {
          type: "image/svg+xml",
        }),
      ],
      ["logo", "just a string"],
    ] as const;
    for (const [kind, file] of bad) {
      const res = await upload(server, kind, file as File | string);
      expect(res.status).toBe(400);
    }
    expect(store.size).toBe(0);

    const ok = await upload(
      server,
      "logo",
      new File(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], "a.svg", {
        type: "image/svg+xml",
      }),
    );
    expect(ok.status).toBe(201);
  });

  it("requires authentication", async () => {
    const { adapter } = memoryStorage();
    const server = await getTestServer({
      wrapDataAdapter: (d) => ({ ...d, storage: adapter }),
    });
    const form = new FormData();
    form.set("file", new File([PNG], "a.png", { type: "image/png" }));
    const res = await server.app.request(
      "/api/v2/branding/uploads/logo",
      { method: "POST", headers: { "tenant-id": "tenantId" }, body: form },
      server.env,
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /assets", () => {
  it("404s for unknown objects, bad kinds and traversal attempts", async () => {
    const { adapter } = memoryStorage();
    const server = await getTestServer({
      wrapDataAdapter: (d) => ({ ...d, storage: adapter }),
    });
    for (const p of [
      "/assets/tenants/tenantId/branding/logo/missing.png",
      "/assets/tenants/tenantId/branding/other/x.png",
      "/assets/tenants/tenantId/branding/logo/..%2Fx.png",
    ]) {
      const res = await server.app.request(p, {}, server.env);
      expect(res.status).toBe(404);
    }
  });
});
