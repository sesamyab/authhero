import { z } from "@hono/zod-openapi";

// Auth0 trigger ids — kept as a union for typing, not a closed enum, so new
// triggers (e.g. event-stream, custom-token-exchange) don't require a schema
// bump every time Auth0 ships one.
export const actionExecutionTriggerIdSchema = z.string();

export const actionExecutionStatusSchema = z.enum([
  "unspecified",
  "pending",
  "final",
  "partial",
  "canceled",
  "suspended",
]);
export type ActionExecutionStatus = z.infer<typeof actionExecutionStatusSchema>;

export const actionExecutionErrorSchema = z.object({
  id: z.string(),
  msg: z.string(),
  url: z.string().optional(),
});
export type ActionExecutionError = z.infer<typeof actionExecutionErrorSchema>;

export const actionExecutionResultSchema = z.object({
  action_name: z.string(),
  error: actionExecutionErrorSchema.nullable(),
  started_at: z.string(),
  ended_at: z.string(),
});
export type ActionExecutionResult = z.infer<typeof actionExecutionResultSchema>;

// Logs captured per-action during execution. Not part of Auth0's executions
// API response shape — Auth0 exposes these in a separate real-time logs
// stream — but we persist them here so the admin UI has a single place to
// surface them. Public GET responses omit this field.
export const actionExecutionLogEntrySchema = z.object({
  level: z.enum(["log", "info", "warn", "error", "debug"]),
  message: z.string(),
});
export type ActionExecutionLogEntry = z.infer<
  typeof actionExecutionLogEntrySchema
>;

export const actionExecutionLogsSchema = z.array(
  z.object({
    action_name: z.string(),
    lines: z.array(actionExecutionLogEntrySchema),
  }),
);
export type ActionExecutionLogs = z.infer<typeof actionExecutionLogsSchema>;

export const actionExecutionSchema = z.object({
  id: z.string(),
  tenant_id: z.string(),
  trigger_id: actionExecutionTriggerIdSchema,
  status: actionExecutionStatusSchema,
  results: z.array(actionExecutionResultSchema),
  logs: actionExecutionLogsSchema.optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ActionExecution = z.infer<typeof actionExecutionSchema>;

export const actionExecutionInsertSchema = actionExecutionSchema.omit({
  tenant_id: true,
  created_at: true,
  updated_at: true,
});
export type ActionExecutionInsert = z.infer<typeof actionExecutionInsertSchema>;
