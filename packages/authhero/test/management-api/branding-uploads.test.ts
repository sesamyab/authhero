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

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

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
      ["logo", new File([PNG.slice(0, 4)], "a.png", { type: "image/png" })],
      [
        "logo",
        new File(["<!-- <svg> --> hello"], "a.svg", { type: "image/svg+xml" }),
      ],
      [
        "logo",
        new File(
          ['<svg xmlns="x"><a xlink:href="&#106;avascript:alert(1)"/></svg>'],
          "a.svg",
          { type: "image/svg+xml" },
        ),
      ],
      [
        "logo",
        new File(
          ['<svg xmlns="x"><image href="https://evil.test/x.png"/></svg>'],
          "a.svg",
          {
            type: "image/svg+xml",
          },
        ),
      ],
      [
        "logo",
        new File(
          [
            '<svg xmlns="x"><style>@\\69mport "https://e.test/a.css";</style></svg>',
          ],
          "a.svg",
          { type: "image/svg+xml" },
        ),
      ],
      [
        "logo",
        new File(
          [
            '<svg xmlns="x"><style><![CDATA[ svg{background-image:u\\72l(https://e.test/p.png)} ]]></style></svg>',
          ],
          "a.svg",
          { type: "image/svg+xml" },
        ),
      ],
      [
        "logo",
        new File(
          [
            '<?xml-stylesheet type="text/css" href="https://e.test/a.css"?><svg xmlns="x"/>',
          ],
          "a.svg",
          { type: "image/svg+xml" },
        ),
      ],
      [
        "logo",
        new File(
          ['<svg xmlns="x"><style>@font-face{}</style></svg>'],
          "a.svg",
          {
            type: "image/svg+xml",
          },
        ),
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

    const withAt = await upload(
      server,
      "logo",
      new File(
        [
          '<svg xmlns="http://www.w3.org/2000/svg"><title>@studio</title></svg>',
        ],
        "a.svg",
        { type: "image/svg+xml" },
      ),
    );
    expect(withAt.status).toBe(201);
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

describe("upload edge cases", () => {
  it("accepts a font with an empty MIME type via its extension, with a valid signature", async () => {
    const { adapter } = memoryStorage();
    const server = await getTestServer({
      wrapDataAdapter: (d) => ({ ...d, storage: adapter }),
    });
    const woff2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]);
    const ok = await upload(
      server,
      "font",
      new File([woff2], "f.woff2", { type: "" }),
    );
    expect(ok.status).toBe(201);
    const bad = await upload(
      server,
      "font",
      new File([PNG], "f.woff2", { type: "" }),
    );
    expect(bad.status).toBe(400);
  });

  it("always returns the /assets URL for SVGs, even with a public base URL", async () => {
    const { adapter } = memoryStorage("https://assets.example.com");
    const server = await getTestServer({
      wrapDataAdapter: (d) => ({ ...d, storage: adapter }),
    });
    const res = await upload(
      server,
      "logo",
      new File(
        [
          '<?xml version="1.0"?><!-- c --><svg xmlns="http://www.w3.org/2000/svg"/>',
        ],
        "a.svg",
        {
          type: "image/svg+xml",
        },
      ),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.url).toBe(`${server.env.ISSUER}assets/${body.key}`);
  });

  it("rejects oversized request bodies with 413", async () => {
    const { adapter } = memoryStorage();
    const server = await getTestServer({
      wrapDataAdapter: (d) => ({ ...d, storage: adapter }),
    });
    const big = new File([new Uint8Array(6 * 1024 * 1024)], "a.png", {
      type: "image/png",
    });
    const res = await upload(server, "logo", big);
    expect(res.status).toBe(413);
  });

  it("round-trips a tenant id with URL-special characters", async () => {
    const { adapter } = memoryStorage();
    const server = await getTestServer({
      wrapDataAdapter: (d) => ({ ...d, storage: adapter }),
    });
    await server.env.data.tenants.create({
      id: "team#west",
      friendly_name: "T",
      audience: "https://example.com",
      sender_email: "a@example.com",
      sender_name: "A",
    });
    const res = await upload(
      server,
      "logo",
      new File([PNG], "a.png", { type: "image/png" }),
      "team#west",
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.url).toContain("team%23west");
    const served = await server.app.request(
      new URL(body.url).pathname,
      {},
      server.env,
    );
    expect(served.status).toBe(200);
  });
});

describe("GET /assets", () => {
  it("404s for unknown objects, bad kinds and traversal attempts", async () => {
    const { adapter } = memoryStorage();
    const calls: string[] = [];
    const spied: StorageAdapter = {
      ...adapter,
      get: async (key) => {
        calls.push(key);
        return adapter.get(key);
      },
    };
    const server = await getTestServer({
      wrapDataAdapter: (d) => ({ ...d, storage: spied }),
    });
    const missing = await server.app.request(
      "/assets/tenants/tenantId/branding/logo/missing.png",
      {},
      server.env,
    );
    expect(missing.status).toBe(404);
    expect(calls).toHaveLength(1); // valid lookup reached storage

    for (const p of [
      "/assets/tenants/tenantId/branding/other/x.png",
      "/assets/tenants/tenantId/branding/logo/..%2Fx.png",
    ]) {
      const res = await server.app.request(p, {}, server.env);
      expect(res.status).toBe(404);
    }
    expect(calls).toHaveLength(1); // invalid ones never did
  });
});
