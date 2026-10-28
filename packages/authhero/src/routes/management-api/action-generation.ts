import { createRoute, z } from "@hono/zod-openapi";
import {
  getCodeHookApiTypeDeclarations,
  TRIGGER_FUNCTION_NAMES,
} from "@authhero/adapter-interfaces";
import { defineRoute } from "../../utils/define-route";
import { managementError } from "../../errors/management-api-error";
import {
  normalizeActionTrigger,
  verifyActionCode,
} from "../../helpers/action-verification";
import { requireTenantId } from "./helpers";

const modelSchema = z.enum(["glm", "deepseek", "qwen"]);
const headers = z.object({ "tenant-id": z.string().optional() });
const security = [{ Bearer: ["create:actions", "update:actions"] }];
const verificationSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.string()),
});
const sourceSchema = z.object({
  code: z.string().min(1).max(100_000),
  supported_triggers: z
    .array(z.object({ id: z.string() }))
    .min(1)
    .max(10),
});

const getGeneration = defineRoute({
  route: createRoute({
    tags: ["actions"],
    method: "get",
    path: "/generation",
    security,
    request: { headers },
    responses: {
      200: {
        description: "Available generation models and save verification policy",
        content: {
          "application/json": {
            schema: z.object({
              models: z.array(modelSchema),
              verification_required: z.boolean(),
            }),
          },
        },
      },
    },
  }),
  handler: async (ctx) => {
    requireTenantId(ctx);
    return ctx.json({
      models: [...(ctx.env.actionCodeGenerator?.models ?? [])],
      verification_required: !!ctx.env.actionCodeGenerator,
    });
  },
});

const postGenerate = defineRoute({
  route: createRoute({
    tags: ["actions"],
    method: "post",
    path: "/generate",
    security,
    request: {
      headers,
      body: {
        content: {
          "application/json": {
            schema: z.object({
              prompt: z.string().trim().min(1).max(10_000),
              model: modelSchema,
              trigger_id: z
                .string()
                .refine(
                  (id) =>
                    Object.hasOwn(
                      TRIGGER_FUNCTION_NAMES,
                      normalizeActionTrigger(id),
                    ),
                  "Unsupported trigger",
                ),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description:
          "Unsaved generated source and its static verification result",
        content: {
          "application/json": {
            schema: z.object({
              code: z.string(),
              verification: verificationSchema,
            }),
          },
        },
      },
      400: { description: "Unsupported model" },
      502: { description: "Generation failed" },
      503: { description: "No generator configured" },
    },
  }),
  handler: async (ctx) => {
    const tenantId = requireTenantId(ctx);
    const generator = ctx.env.actionCodeGenerator;
    if (!generator)
      throw managementError(503, "Action code generation is not configured");
    const { prompt, model, trigger_id } = ctx.req.valid("json");
    if (!generator.models.includes(model))
      throw managementError(400, "This generation model is not available");
    let code: string;
    try {
      ({ code } = await generator.generate({
        tenantId,
        prompt,
        model,
        triggerId: trigger_id,
        apiTypes: getCodeHookApiTypeDeclarations(trigger_id),
      }));
      if (typeof code !== "string" || !code.trim() || code.length > 100_000)
        throw new Error("Invalid source");
    } catch {
      throw managementError(502, "Action generation failed. Please try again.");
    }
    return ctx.json({
      code,
      verification: verifyActionCode(code, [{ id: trigger_id }]),
    });
  },
});

const postVerify = defineRoute({
  route: createRoute({
    tags: ["actions"],
    method: "post",
    path: "/verify",
    security,
    request: {
      headers,
      body: { content: { "application/json": { schema: sourceSchema } } },
    },
    responses: {
      200: {
        description:
          "Static verification without executing or saving the script",
        content: {
          "application/json": { schema: verificationSchema },
        },
      },
    },
  }),
  handler: async (ctx) => {
    requireTenantId(ctx);
    const { code, supported_triggers } = ctx.req.valid("json");
    return ctx.json(verifyActionCode(code, supported_triggers));
  },
});

export const actionGenerationRoutes = [
  getGeneration,
  postGenerate,
  postVerify,
] as const;
