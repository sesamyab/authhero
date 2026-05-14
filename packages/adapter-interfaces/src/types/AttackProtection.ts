import { z } from "@hono/zod-openapi";

export const breachedPasswordDetectionSchema = z.object({
  enabled: z.boolean().optional(),
  shields: z.array(z.string()).optional(),
  admin_notification_frequency: z.array(z.string()).optional(),
  method: z.string().optional(),
  stage: z
    .object({
      "pre-user-registration": z
        .object({
          shields: z.array(z.string()).optional(),
        })
        .optional(),
      "pre-change-password": z
        .object({
          shields: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
});

export type BreachedPasswordDetection = z.infer<
  typeof breachedPasswordDetectionSchema
>;

export const bruteForceProtectionSchema = z.object({
  enabled: z.boolean().optional(),
  shields: z.array(z.string()).optional(),
  allowlist: z.array(z.string()).optional(),
  mode: z.string().optional(),
  max_attempts: z.number().optional(),
});

export type BruteForceProtection = z.infer<typeof bruteForceProtectionSchema>;

export const suspiciousIpThrottlingSchema = z.object({
  enabled: z.boolean().optional(),
  shields: z.array(z.string()).optional(),
  allowlist: z.array(z.string()).optional(),
  stage: z
    .object({
      "pre-login": z
        .object({
          max_attempts: z.number().optional(),
          rate: z.number().optional(),
        })
        .optional(),
      "pre-user-registration": z
        .object({
          max_attempts: z.number().optional(),
          rate: z.number().optional(),
        })
        .optional(),
    })
    .optional(),
});

export type SuspiciousIpThrottling = z.infer<
  typeof suspiciousIpThrottlingSchema
>;

export const attackProtectionSchema = z.object({
  breached_password_detection: breachedPasswordDetectionSchema.optional(),
  brute_force_protection: bruteForceProtectionSchema.optional(),
  suspicious_ip_throttling: suspiciousIpThrottlingSchema.optional(),
});

export type AttackProtection = z.infer<typeof attackProtectionSchema>;
