import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  managementError,
  managementValidationHook,
  notFound,
} from "../../errors/management-api-error";
import { HTTPException } from "hono/http-exception";
import {
  LogStream,
  logStreamInsertSchema,
  logStreamSchema,
  LogTypes,
  trimCredentialFields,
} from "@authhero/adapter-interfaces";
import { Bindings, Variables } from "../../types";
import { logMessage } from "../../helpers/logging";

import { defineRoute } from "../../utils/define-route";
import { requireTenantId } from "./helpers";
import { parseFirehoseSink } from "../../helpers/outbox-destinations/log-streams";

/**
 * Sink credentials that are accepted on create/update but never returned.
 * `httpAuthorization` is the camelCase spelling Auth0 clients (e.g. the
 * Terraform provider) send.
 */
const WRITE_ONLY_SINK_FIELDS = [
  "aws_secret_access_key",
  "http_authorization",
  "httpAuthorization",
];

/**
 * Sink credentials that get leading/trailing whitespace trimmed on write: a
 * pasted key often carries a trailing newline, which breaks request signing
 * or the Authorization header.
 */
const TRIMMED_SINK_FIELDS = [
  ...WRITE_ONLY_SINK_FIELDS,
  "aws_access_key_id",
] as const;

function toResponse(stream: LogStream): LogStream {
  if (!WRITE_ONLY_SINK_FIELDS.some((field) => field in stream.sink)) {
    return stream;
  }
  const sink = { ...stream.sink };
  for (const field of WRITE_ONLY_SINK_FIELDS) {
    delete sink[field];
  }
  return { ...stream, sink };
}

/**
 * The write-only fields are never returned, so a client editing a sink sends
 * it without them. Keep each stored value unless the update supplies a new
 * one; an explicit `null` removes it (e.g. to drop an Authorization header).
 */
function mergeWriteOnlyFields(
  next: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...next };
  for (const field of WRITE_ONLY_SINK_FIELDS) {
    const value = next[field];
    if (value === null) {
      delete merged[field];
    } else if (
      (value === undefined || value === "") &&
      typeof stored[field] === "string"
    ) {
      merged[field] = stored[field];
    }
  }
  return merged;
}

function assertValidSink(type: string, sink: Record<string, unknown>) {
  if (type !== "firehose") return;
  const parsed = parseFirehoseSink(sink);
  if ("error" in parsed) {
    throw managementError(
      400,
      `Invalid firehose sink: ${parsed.error}`,
      "invalid_body",
    );
  }
}

function getAdapter(ctx: { env: Bindings }) {
  const adapter = ctx.env.data.logStreams;
  if (!adapter) {
    throw new HTTPException(501, {
      message: "Log streams are not supported by this adapter",
    });
  }
  return adapter;
}
const getRoot = defineRoute({
  route: createRoute({
    tags: ["log-streams"],
    method: "get",
    path: "/",
    request: {
      headers: z.object({ "tenant-id": z.string().optional() }),
    },
    security: [{ Bearer: ["read:log_streams"] }],
    responses: {
      200: {
        content: {
          "application/json": { schema: z.array(logStreamSchema) },
        },
        description: "List of log streams",
      },
    },
  }),
  handler: async (ctx) => {
    const tenantId = requireTenantId(ctx);
    const adapter = getAdapter(ctx);
    const result = await adapter.list(tenantId);
    return ctx.json(result.map(toResponse));
  },
});

const getById = defineRoute({
  route: createRoute({
    tags: ["log-streams"],
    method: "get",
    path: "/{id}",
    request: {
      params: z.object({ id: z.string() }),
      headers: z.object({ "tenant-id": z.string().optional() }),
    },
    security: [{ Bearer: ["read:log_streams"] }],
    responses: {
      200: {
        content: { "application/json": { schema: logStreamSchema } },
        description: "A log stream",
      },
    },
  }),
  handler: async (ctx) => {
    const tenantId = requireTenantId(ctx);
    const adapter = getAdapter(ctx);
    const { id } = ctx.req.valid("param");
    const stream = await adapter.get(tenantId, id);
    if (!stream) {
      throw notFound.logStream();
    }
    return ctx.json(toResponse(stream));
  },
});

const postRoot = defineRoute({
  route: createRoute({
    tags: ["log-streams"],
    method: "post",
    path: "/",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object(logStreamInsertSchema.shape),
          },
        },
      },
      headers: z.object({ "tenant-id": z.string().optional() }),
    },
    security: [{ Bearer: ["create:log_streams"] }],
    responses: {
      201: {
        content: { "application/json": { schema: logStreamSchema } },
        description: "The created log stream",
      },
    },
  }),
  handler: async (ctx) => {
    const tenantId = requireTenantId(ctx);
    const adapter = getAdapter(ctx);
    const input = ctx.req.valid("json");
    const body = {
      ...input,
      sink: trimCredentialFields(input.sink, TRIMMED_SINK_FIELDS),
    };
    assertValidSink(body.type, body.sink);
    const stream = await adapter.create(tenantId, body);

    await logMessage(ctx, tenantId, {
      type: LogTypes.SUCCESS_API_OPERATION,
      description: "Create a Log Stream",
      targetType: "log_stream",
      targetId: stream.id,
      afterState: stream as Record<string, unknown>,
    });

    return ctx.json(toResponse(stream), { status: 201 });
  },
});

const patchById = defineRoute({
  route: createRoute({
    tags: ["log-streams"],
    method: "patch",
    path: "/{id}",
    request: {
      params: z.object({ id: z.string() }),
      body: {
        content: {
          "application/json": {
            schema: z.object(logStreamSchema.shape).partial(),
          },
        },
      },
      headers: z.object({ "tenant-id": z.string().optional() }),
    },
    security: [{ Bearer: ["update:log_streams"] }],
    responses: {
      200: {
        content: { "application/json": { schema: logStreamSchema } },
        description: "The updated log stream",
      },
    },
  }),
  handler: async (ctx) => {
    const tenantId = requireTenantId(ctx);
    const adapter = getAdapter(ctx);
    const { id } = ctx.req.valid("param");
    const body = ctx.req.valid("json");
    const existing = await adapter.get(tenantId, id);
    if (!existing) {
      throw notFound.logStream();
    }
    if (body.sink) {
      body.sink = trimCredentialFields(body.sink, TRIMMED_SINK_FIELDS);
    }
    // Carry stored credentials over only within the same type, so switching
    // type can't leak an old type's credential into the new sink.
    if (body.sink && (body.type ?? existing.type) === existing.type) {
      body.sink = mergeWriteOnlyFields(body.sink, existing.sink);
    }
    assertValidSink(body.type ?? existing.type, body.sink ?? existing.sink);
    const ok = await adapter.update(tenantId, id, body);
    if (!ok) {
      throw notFound.logStream();
    }
    const stream = await adapter.get(tenantId, id);
    if (!stream) {
      throw notFound.logStream();
    }

    await logMessage(ctx, tenantId, {
      type: LogTypes.SUCCESS_API_OPERATION,
      description: "Update a Log Stream",
      targetType: "log_stream",
      targetId: id,
      beforeState: { ...existing },
      afterState: stream as Record<string, unknown>,
    });

    return ctx.json(toResponse(stream));
  },
});

const deleteById = defineRoute({
  route: createRoute({
    tags: ["log-streams"],
    method: "delete",
    path: "/{id}",
    request: {
      params: z.object({ id: z.string() }),
      headers: z.object({ "tenant-id": z.string().optional() }),
    },
    security: [{ Bearer: ["delete:log_streams"] }],
    responses: {
      204: { description: "Log stream deleted" },
    },
  }),
  handler: async (ctx) => {
    const tenantId = requireTenantId(ctx);
    const adapter = getAdapter(ctx);
    const { id } = ctx.req.valid("param");
    const existing = await adapter.get(tenantId, id);
    const ok = await adapter.remove(tenantId, id);
    if (!ok) {
      throw notFound.logStream();
    }

    // A delete has no after state — consumers fall back to `before`.
    await logMessage(ctx, tenantId, {
      type: LogTypes.SUCCESS_API_OPERATION,
      description: "Delete a Log Stream",
      targetType: "log_stream",
      targetId: id,
      ...(existing ? { beforeState: { ...existing } } : {}),
    });

    return ctx.body(null, 204);
  },
});

export const logStreamsRoutes = new OpenAPIHono<{
  Bindings: Bindings;
  Variables: Variables;
}>({ defaultHook: managementValidationHook }).openapiRoutes([
  getRoot,
  getById,
  postRoot,
  patchById,
  deleteById,
] as const);
