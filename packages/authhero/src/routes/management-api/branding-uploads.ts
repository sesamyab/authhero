import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { LogTypes, storageKeyToUrlPath } from "@authhero/adapter-interfaces";
import { Bindings, Variables } from "../../types";
import { managementValidationHook } from "../../errors/management-api-error";
import { defineRoute } from "../../utils/define-route";
import { logMessage } from "../../helpers/logging";
import { getIssuer } from "../../variables";
import { requireTenantId } from "./helpers";
import {
  BRANDING_ASSET_CACHE_CONTROL,
  BRANDING_ASSET_KINDS,
  BRANDING_ASSET_RULES,
  brandingAssetKey,
  isSafeSvg,
  matchesSignature,
  resolveContentType,
} from "../../helpers/branding-assets";

// Largest file (5 MB) plus multipart overhead.
const MAX_REQUEST_BYTES = 5 * 1024 * 1024 + 64 * 1024;

const uploadResponseSchema = z.object({
  url: z.string(),
  key: z.string(),
  content_type: z.string(),
  size: z.number(),
});

const postUpload = defineRoute({
  route: createRoute({
    tags: ["branding"],
    method: "post",
    path: "/{kind}",
    request: {
      headers: z.object({ "tenant-id": z.string().optional() }),
      params: z.object({ kind: z.enum(BRANDING_ASSET_KINDS) }),
      body: {
        content: {
          "multipart/form-data": {
            schema: z.object({
              file: z.any().openapi({
                type: "string",
                format: "binary",
                description: "The image or font file to upload.",
              }),
            }),
          },
        },
      },
    },
    security: [{ Bearer: ["update:branding"] }],
    // Cap actual request bytes before the multipart body is buffered/parsed.
    middleware: [
      bodyLimit({
        maxSize: MAX_REQUEST_BYTES,
        onError: (c) => c.json({ message: "Request body too large" }, 413),
      }),
    ] as const,
    responses: {
      201: {
        content: { "application/json": { schema: uploadResponseSchema } },
        description:
          "The file was stored. Put `url` in the matching branding URL field.",
      },
      400: { description: "Invalid file (type, size or content)" },
      501: { description: "No storage adapter is configured" },
    },
  }),
  handler: async (ctx) => {
    const tenantId = requireTenantId(ctx);
    const { kind } = ctx.req.valid("param");
    const storage = ctx.env.data.storage;
    if (!storage) {
      throw new HTTPException(501, {
        message: "File storage is not configured",
      });
    }

    const form = await ctx.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) {
      throw new HTTPException(400, { message: "A file is required" });
    }

    const rule = BRANDING_ASSET_RULES[kind];
    if (file.size === 0 || file.size > rule.maxBytes) {
      throw new HTTPException(400, {
        message: `The file must be between 1 byte and ${rule.maxBytes} bytes`,
      });
    }
    const contentType = resolveContentType(
      kind,
      file.type.split(";")[0]!.trim().toLowerCase(),
      file.name,
    );
    const ext = rule.types[contentType];
    if (!ext) {
      throw new HTTPException(400, {
        message: `Unsupported content type for ${kind}. Allowed: ${Object.keys(rule.types).join(", ")}`,
      });
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!matchesSignature(contentType, bytes)) {
      throw new HTTPException(400, {
        message: "The file content does not match its content type",
      });
    }
    if (contentType === "image/svg+xml" && !isSafeSvg(bytes)) {
      throw new HTTPException(400, {
        message: "The SVG is invalid or contains active content",
      });
    }

    // Tenant id comes from the authenticated request context, never the
    // client, so an upload can only land under the caller's own prefix.
    const key = brandingAssetKey(tenantId, kind, crypto.randomUUID(), ext);
    // Resolve the URL before writing so a lookup failure can't orphan an
    // object. SVGs always go through the auth server (restrictive CSP), never
    // a direct bucket URL.
    const publicUrl =
      contentType === "image/svg+xml"
        ? undefined
        : await storage.getPublicUrl(key);
    const url =
      publicUrl ??
      `${getIssuer(ctx.env, ctx.var.custom_domain)}assets/${storageKeyToUrlPath(key)}`;

    await storage.put(key, bytes, {
      contentType,
      cacheControl: BRANDING_ASSET_CACHE_CONTROL,
    });

    await logMessage(ctx, tenantId, {
      type: LogTypes.SUCCESS_API_OPERATION,
      description: `Upload branding ${kind}`,
      targetType: "branding",
      targetId: tenantId,
      afterState: { key, url, content_type: contentType, size: bytes.length },
    });

    return ctx.json(
      { url, key, content_type: contentType, size: bytes.length },
      201,
    );
  },
});

export const brandingUploadsRoutes = new OpenAPIHono<{
  Bindings: Bindings;
  Variables: Variables;
}>({ defaultHook: managementValidationHook }).openapiRoutes([
  postUpload,
] as const);
