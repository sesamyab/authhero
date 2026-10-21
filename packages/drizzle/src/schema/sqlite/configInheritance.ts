import { integer, text } from "drizzle-orm/sqlite-core";

/**
 * Publishing properties for tenant config inheritance
 * (docs/design/tenant-config-inheritance.md, section 3.2). All nullable: unset
 * reads as scope `local`, override `none`, enforce false.
 *
 * A function, not a constant, because column builders are stateful and must
 * not be shared between tables.
 */
export const configInheritanceColumns = () => ({
  scope: text("scope", { length: 16, enum: ["local", "shared", "platform"] }),
  override: text("override", {
    length: 16,
    enum: ["none", "secrets", "fields"],
  }),
  enforce: integer("enforce", { mode: "boolean" }),
});
