import { z } from "@hono/zod-openapi";

/**
 * Publishing properties for tenant config inheritance
 * (docs/design/tenant-config-inheritance.md, section 3.2).
 *
 * Unset (null/undefined) reads as `scope: "local"`, `override: "none"`,
 * `enforce: false`, which is today's behaviour.
 */
export const configScopeSchema = z.enum(["local", "shared", "platform"]);
export type ConfigScope = z.infer<typeof configScopeSchema>;

export const configOverrideSchema = z.enum(["none", "secrets", "fields"]);
export type ConfigOverride = z.infer<typeof configOverrideSchema>;

export const configInheritanceShape = {
  /**
   * `local`: not published. `shared`: visible to child tenants, who may copy
   * or override it. `platform`: hidden from and locked for children, run only.
   */
  scope: configScopeSchema.optional(),
  /** What a child may change on a `shared` row. */
  override: configOverrideSchema.optional(),
  /** A child cannot disable or delete the row. */
  enforce: z.boolean().optional(),
};
