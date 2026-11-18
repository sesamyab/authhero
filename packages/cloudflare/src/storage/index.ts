import type {
  StorageAdapter,
  StorageObject,
  StoragePutOptions,
} from "@authhero/adapter-interfaces";

/** Minimal structural type of a Workers R2 bucket binding. */
export interface R2BucketLike {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    options?: {
      httpMetadata?: { contentType?: string; cacheControl?: string };
    },
  ): Promise<unknown>;
  get(key: string): Promise<{
    body: ReadableStream<Uint8Array>;
    size?: number;
    httpEtag?: string;
    httpMetadata?: { contentType?: string; cacheControl?: string };
  } | null>;
  delete(key: string): Promise<void>;
}

export interface CloudflareStorageAdapterConfig {
  /** The shared R2 bucket binding. */
  bucket: R2BucketLike;
  /**
   * Base URL of a public assets domain in front of the bucket (e.g.
   * `https://assets.example.com`). When omitted the auth server serves
   * objects itself at `/assets/{key}`.
   */
  publicBaseUrl?: string;
}

export function createCloudflareStorageAdapter(
  config: CloudflareStorageAdapterConfig,
): StorageAdapter {
  const base = config.publicBaseUrl?.replace(/\/+$/, "");
  return {
    async put(key: string, body, options: StoragePutOptions) {
      await config.bucket.put(key, body, {
        httpMetadata: {
          contentType: options.contentType,
          ...(options.cacheControl && { cacheControl: options.cacheControl }),
        },
      });
    },
    async get(key: string): Promise<StorageObject | null> {
      const obj = await config.bucket.get(key);
      if (!obj) return null;
      return {
        body: obj.body,
        contentType: obj.httpMetadata?.contentType,
        cacheControl: obj.httpMetadata?.cacheControl,
        size: obj.size,
        etag: obj.httpEtag,
      };
    },
    async delete(key: string) {
      await config.bucket.delete(key);
    },
    getPublicUrl(key: string) {
      return base ? `${base}/${key}` : undefined;
    },
  };
}
