import { z } from "@hono/zod-openapi";

export const logStreamTypeSchema = z.enum([
  "http",
  "eventbridge",
  "eventgrid",
  "splunk",
  "datadog",
  "sumo",
]);

export const logStreamStatusSchema = z.enum(["active", "paused", "suspended"]);

export const logStreamFilterSchema = z.object({
  type: z.string(),
  name: z.string(),
});

export const logStreamInsertSchema = z.object({
  name: z.string(),
  type: logStreamTypeSchema,
  status: logStreamStatusSchema.optional(),
  sink: z.record(z.string(), z.unknown()),
  filters: z.array(logStreamFilterSchema).optional(),
  isPriority: z.boolean().optional(),
});

export type LogStreamInsert = z.infer<typeof logStreamInsertSchema>;

export const logStreamSchema = logStreamInsertSchema.extend({
  id: z.string(),
  status: logStreamStatusSchema,
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

export type LogStream = z.infer<typeof logStreamSchema>;
