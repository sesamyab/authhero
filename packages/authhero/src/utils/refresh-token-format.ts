import { sha256 } from "oslo/crypto";
import { base64url, encodeHex } from "oslo/encoding";

export const REFRESH_TOKEN_PREFIX = "rt_";
export const LOOKUP_BYTES = 7;
export const SECRET_BYTES = 32;

// After this date the legacy (un-prefixed, id-only) refresh-token format is
// rejected. New format has been the default since 2026-05-05; the ~30 day
// window covers a full max-age refresh-token lifetime.
export const LEGACY_CUTOFF = new Date("2026-06-05T00:00:00.000Z");

export type ParsedRefreshToken =
  | { kind: "new"; lookup: string; secret: string }
  | { kind: "legacy"; id: string };

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function generateRefreshTokenParts(): {
  lookup: string;
  secret: string;
} {
  return {
    lookup: base64url.encode(randomBytes(LOOKUP_BYTES), {
      includePadding: false,
    }),
    secret: base64url.encode(randomBytes(SECRET_BYTES), {
      includePadding: false,
    }),
  };
}

export async function hashRefreshTokenSecret(secret: string): Promise<string> {
  return encodeHex(await sha256(new TextEncoder().encode(secret)));
}

export function formatRefreshToken(lookup: string, secret: string): string {
  return `${REFRESH_TOKEN_PREFIX}${lookup}.${secret}`;
}

export function parseRefreshToken(token: string): ParsedRefreshToken {
  if (token.startsWith(REFRESH_TOKEN_PREFIX)) {
    const body = token.slice(REFRESH_TOKEN_PREFIX.length);
    const dot = body.indexOf(".");
    if (dot > 0 && dot < body.length - 1) {
      return {
        kind: "new",
        lookup: body.slice(0, dot),
        secret: body.slice(dot + 1),
      };
    }
  }
  return { kind: "legacy", id: token };
}

export function isLegacyRefreshTokenAccepted(now: Date = new Date()): boolean {
  return now < LEGACY_CUTOFF;
}
