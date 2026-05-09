import { Kysely } from "kysely";
import {
  EmailTemplate,
  emailTemplateSchema,
} from "@authhero/adapter-interfaces";
import { Database } from "../db";
import { rowToTemplate } from "./row";

export function list(db: Kysely<Database>) {
  return async (tenant_id: string): Promise<EmailTemplate[]> => {
    const rows = await db
      .selectFrom("email_templates")
      .where("tenant_id", "=", tenant_id)
      .selectAll()
      .execute();

    return rows.map((row) => emailTemplateSchema.parse(rowToTemplate(row)));
  };
}
