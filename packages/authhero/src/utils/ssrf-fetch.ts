const PRIVATE_IPV4_PATTERNS = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local
  /^127\./, // loopback
  /^0\./, // current network
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
];

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "broadcasthost",
]);

function isBlockedIPv6(hostname: string): boolean {
  // Strip the surrounding brackets that URL parsing leaves on IPv6 literals.
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "::" || h === "::1") return true;
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique local
  if (h.startsWith("fe80:")) return true; // link-local
  return false;
}

function isBlockedIPv4(hostname: string): boolean {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return false;
  return PRIVATE_IPV4_PATTERNS.some((re) => re.test(hostname));
}

export interface SsrfFetchOptions {
  /** Max bytes to read from the response body. Defaults to 64 KiB. */
  maxBytes?: number;
  /** Request timeout in ms. Defaults to 5000ms. */
  timeoutMs?: number;
  /** Allowed schemes. Defaults to ["https:"]. Set to ["http:", "https:"] for tests. */
  allowedSchemes?: string[];
  /**
   * When true, hostnames resolving to private/loopback ranges (and
   * `localhost`) are allowed. Intended for tests only.
   */
  allowPrivateHosts?: boolean;
}

export class SsrfBlockedError extends Error {
  constructor(reason: string) {
    super(`SSRF check failed: ${reason}`);
    this.name = "SsrfBlockedError";
  }
}

export function assertSsrfSafeUrl(
  rawUrl: string,
  opts: SsrfFetchOptions = {},
): URL {
  const allowedSchemes = opts.allowedSchemes ?? ["https:"];
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError("invalid URL");
  }
  if (!allowedSchemes.includes(url.protocol)) {
    throw new SsrfBlockedError(`scheme ${url.protocol} not allowed`);
  }
  if (opts.allowPrivateHosts) return url;

  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new SsrfBlockedError(`hostname ${host} blocked`);
  }
  if (isBlockedIPv4(host)) {
    throw new SsrfBlockedError(`IPv4 ${host} is in a blocked range`);
  }
  if (host.includes(":") && isBlockedIPv6(host)) {
    throw new SsrfBlockedError(`IPv6 ${host} is in a blocked range`);
  }
  return url;
}

/**
 * Fetch a URL with SSRF protection: blocks private/loopback/link-local
 * targets, requires https by default, applies a strict timeout, and caps the
 * response body. Intended for fetching client-published artifacts (jwks_uri,
 * request_uri) where the URL comes from untrusted client metadata.
 */
export async function ssrfSafeFetch(
  rawUrl: string,
  opts: SsrfFetchOptions = {},
): Promise<{ status: number; body: string; contentType: string | null }> {
  const url = assertSsrfSafeUrl(rawUrl, opts);
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  const timeoutMs = opts.timeoutMs ?? 5000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "application/json, application/jwt, text/plain" },
    });

    if (!response.body) {
      return {
        status: response.status,
        body: "",
        contentType: response.headers.get("content-type"),
      };
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (received > maxBytes) {
          await reader.cancel();
          throw new SsrfBlockedError(
            `response body exceeds ${maxBytes} bytes`,
          );
        }
        chunks.push(value);
      }
    }
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return {
      status: response.status,
      body: new TextDecoder().decode(merged),
      contentType: response.headers.get("content-type"),
    };
  } finally {
    clearTimeout(timer);
  }
}
