import { z } from "@hono/zod-openapi";

export const promptPartialInsertionPoints = [
  "form-content-start",
  "form-content-end",
  "form-footer-start",
  "form-footer-end",
  "secondary-actions-start",
  "secondary-actions-end",
] as const;

export type PromptPartialInsertionPoint =
  (typeof promptPartialInsertionPoints)[number];

/**
 * Auth0-compatible prompt partials, keyed by screen and insertion point.
 *
 * @example
 * ```ts
 * {
 *   signup: {
 *     "form-content-end": "<input name=\"ulp-first-name\">"
 *   }
 * }
 * ```
 */
export type PromptPartials = Record<
  string,
  Partial<Record<PromptPartialInsertionPoint, string>>
>;

const promptPartialScreenSchema = z
  .object({
    "form-content-start": z.string().optional(),
    "form-content-end": z.string().optional(),
    "form-footer-start": z.string().optional(),
    "form-footer-end": z.string().optional(),
    "secondary-actions-start": z.string().optional(),
    "secondary-actions-end": z.string().optional(),
  })
  .strict();

export const promptPartialsSchema: z.ZodType<PromptPartials> = z.record(
  z.string(),
  promptPartialScreenSchema,
);

export const promptPartialsEntrySchema = z.object({
  prompt: z.string(),
  partials: promptPartialsSchema,
});

export type PromptPartialsEntry = z.infer<typeof promptPartialsEntrySchema>;
