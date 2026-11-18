export const BRANDING_ASSET_KINDS = [
  "logo",
  "favicon",
  "powered_by_logo",
  "background",
  "font",
] as const;
export type BrandingAssetKind = (typeof BRANDING_ASSET_KINDS)[number];

interface KindRule {
  maxBytes: number;
  /** content type -> file extension */
  types: Record<string, string>;
}

const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

export const BRANDING_ASSET_RULES: Record<BrandingAssetKind, KindRule> = {
  logo: { maxBytes: 2 * 1024 * 1024, types: IMAGE_TYPES },
  powered_by_logo: { maxBytes: 2 * 1024 * 1024, types: IMAGE_TYPES },
  favicon: {
    maxBytes: 512 * 1024,
    types: {
      ...IMAGE_TYPES,
      "image/x-icon": "ico",
      "image/vnd.microsoft.icon": "ico",
    },
  },
  background: {
    maxBytes: 5 * 1024 * 1024,
    types: {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/webp": "webp",
      "image/svg+xml": "svg",
    },
  },
  font: {
    maxBytes: 2 * 1024 * 1024,
    types: {
      "font/woff2": "woff2",
      "font/woff": "woff",
      "font/ttf": "ttf",
      "font/otf": "otf",
    },
  },
};

export function isBrandingAssetKind(v: string): v is BrandingAssetKind {
  return (BRANDING_ASSET_KINDS as readonly string[]).includes(v);
}

export function brandingAssetKey(
  tenantId: string,
  kind: BrandingAssetKind,
  id: string,
  ext: string,
) {
  return `tenants/${tenantId}/branding/${kind}/${id}.${ext}`;
}

/** Cache-Control for stored objects. Keys are unique per upload, so immutable. */
export const BRANDING_ASSET_CACHE_CONTROL =
  "public, max-age=31536000, immutable";

function startsWith(bytes: Uint8Array, sig: number[], offset = 0) {
  return sig.every((b, i) => bytes[offset + i] === b);
}

/** Verifies the file's magic bytes match the declared content type. */
export function matchesSignature(contentType: string, bytes: Uint8Array) {
  switch (contentType) {
    case "image/png":
      return startsWith(
        bytes,
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      );
    case "image/jpeg":
      return startsWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/gif":
      return startsWith(bytes, [0x47, 0x49, 0x46, 0x38]);
    case "image/webp":
      return (
        startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
        startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
      );
    case "image/x-icon":
    case "image/vnd.microsoft.icon":
      return startsWith(bytes, [0, 0, 1, 0]);
    case "font/woff2":
      return startsWith(bytes, [0x77, 0x4f, 0x46, 0x32]);
    case "font/woff":
      return startsWith(bytes, [0x77, 0x4f, 0x46, 0x46]);
    case "font/ttf":
      return (
        startsWith(bytes, [0, 1, 0, 0]) ||
        startsWith(bytes, [0x74, 0x72, 0x75, 0x65])
      );
    case "font/otf":
      return startsWith(bytes, [0x4f, 0x54, 0x54, 0x4f]);
    case "image/svg+xml":
      return true; // checked by isSafeSvg
    default:
      return false;
  }
}

/**
 * Defence in depth for SVG uploads. Primary protection is that SVGs are only
 * ever served by the auth server's /assets route with a restrictive CSP; this
 * additionally requires an `<svg>` root (after an optional XML declaration,
 * comments and doctype) and rejects active content, entities and references to
 * external resources.
 */
export function isSafeSvg(bytes: Uint8Array) {
  const text = new TextDecoder().decode(bytes);
  const body = text
    .replace(/^\uFEFF/, "")
    .replace(/<\?xml(?![\w-])[\s\S]*?\?>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/gi, (m) =>
      /<!ENTITY/i.test(m) ? "<!ENTITY" : "",
    )
    .trim();
  if (!/^<svg[\s>]/i.test(body)) return false;
  if (/<!ENTITY/i.test(body) || /&#/.test(body)) return false;
  if (
    /<script[\s>]/i.test(body) ||
    /<foreignObject[\s>]/i.test(body) ||
    /\son[a-z]+\s*=/i.test(body) ||
    /javascript:/i.test(body) ||
    // CSS escapes (e.g. `@\\69mport`, `u\\72l(`) can hide at-rules and urls,
    // including inside CDATA. No legitimate logo needs a backslash.
    /\\/.test(body)
  ) {
    return false;
  }
  // At-rules (@import, @font-face, ...) only matter inside CSS, so text such as
  // `<title>@studio</title>` stays valid.
  const css = [
    ...body.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi),
    ...body.matchAll(/style\s*=\s*["']([^"']*)["']/gi),
  ]
    .map((m) => m[1])
    .join("\n");
  if (/@/.test(css)) return false;
  // Only same-document and inline image references are allowed.
  for (const m of body.matchAll(/(?:xlink:)?href\s*=\s*["']([^"']*)["']/gi)) {
    const ref = m[1]!.trim();
    if (!ref.startsWith("#") && !/^data:image\/(png|jpeg|gif|webp);/i.test(ref))
      return false;
  }
  for (const m of body.matchAll(/url\(\s*["']?([^)"']*)/gi)) {
    if (!m[1]!.trim().startsWith("#")) return false;
  }
  return true;
}

const FONT_EXTENSIONS: Record<string, string> = {
  woff2: "font/woff2",
  woff: "font/woff",
  ttf: "font/ttf",
  otf: "font/otf",
};

/**
 * Browsers often report an empty or generic MIME type for fonts. Fall back to
 * the file extension; the magic-byte check still decides acceptance.
 */
export function resolveContentType(
  kind: BrandingAssetKind,
  declared: string,
  filename: string,
) {
  if (
    kind === "font" &&
    (!declared ||
      declared === "application/octet-stream" ||
      !(declared in BRANDING_ASSET_RULES.font.types))
  ) {
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    return FONT_EXTENSIONS[ext] ?? declared;
  }
  return declared;
}
