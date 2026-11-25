export interface StoragePutOptions {
  /** MIME type stored with the object and returned when it is served. */
  contentType: string;
  /** Optional Cache-Control value stored with the object. */
  cacheControl?: string;
}

export interface StorageObject {
  body: ReadableStream<Uint8Array>;
  contentType?: string;
  cacheControl?: string;
  size?: number;
  etag?: string;
}

/**
 * Binary object storage for tenant assets (branding logo, favicon,
 * background, font). Keys are `/`-separated, e.g.
 * `tenants/{tenant_id}/branding/logo/{id}.png`. Implementations: Cloudflare
 * R2 first; S3 or local disk can follow without touching callers.
 */
export interface StorageAdapter {
  put(
    key: string,
    body: ArrayBuffer | Uint8Array,
    options: StoragePutOptions,
  ): Promise<void>;
  /** Read an object; null if it does not exist. */
  get(key: string): Promise<StorageObject | null>;
  /** Delete an object. Deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
  /**
   * Public URL of an object when it is served from a dedicated assets domain.
   * Returns undefined when the adapter has no public base URL, in which case
   * the auth server serves the object itself at `/assets/{key}`. May be async
   * because data adapters are wrapped (timing, caching) in async proxies.
   */
  getPublicUrl(key: string): string | undefined | Promise<string | undefined>;
}
