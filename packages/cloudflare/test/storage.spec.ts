import { describe, expect, it } from "vitest";
import {
  createCloudflareStorageAdapter,
  type R2BucketLike,
} from "../src/storage";

function makeBucket() {
  const store = new Map<string, { data: Uint8Array; meta: any }>();
  const bucket: R2BucketLike = {
    async put(key, value, options) {
      store.set(key, {
        data: value instanceof Uint8Array ? value : new Uint8Array(value),
        meta: options?.httpMetadata,
      });
    },
    async get(key) {
      const o = store.get(key);
      if (!o) return null;
      return {
        body: new Response(o.data).body!,
        size: o.data.byteLength,
        httpEtag: '"abc"',
        httpMetadata: o.meta,
      };
    },
    async delete(key) {
      store.delete(key);
    },
  };
  return { bucket, store };
}

describe("Cloudflare storage adapter", () => {
  it("puts, gets and deletes with metadata", async () => {
    const { bucket, store } = makeBucket();
    const adapter = createCloudflareStorageAdapter({ bucket });
    await adapter.put("a/b.png", new Uint8Array([1, 2, 3]), {
      contentType: "image/png",
      cacheControl: "public, max-age=1",
    });
    const obj = await adapter.get("a/b.png");
    expect(obj?.contentType).toBe("image/png");
    expect(obj?.cacheControl).toBe("public, max-age=1");
    expect(obj?.size).toBe(3);
    expect(obj?.etag).toBe('"abc"');
    await adapter.delete("a/b.png");
    expect(store.size).toBe(0);
    expect(await adapter.get("a/b.png")).toBeNull();
  });

  it("builds public URLs only when a base URL is configured", () => {
    const { bucket } = makeBucket();
    expect(
      createCloudflareStorageAdapter({ bucket }).getPublicUrl("k/x.png"),
    ).toBeUndefined();
    expect(
      createCloudflareStorageAdapter({
        bucket,
        publicBaseUrl: "https://assets.example.com/",
      }).getPublicUrl("k/x.png"),
    ).toBe("https://assets.example.com/k/x.png");
  });
});
