import { Kysely } from "kysely";
import {
  EmailTemplate,
  EmailTemplateName,
  emailTemplateSchema,
} from "@authhero/adapter-interfaces";
import { Database } from "../db";
import { rowToTemplate } from "./row";

export function get(db: Kysely<Database>) {
  return async (
    tenant_id: string,
    templateName: EmailTemplateName,
  ): Promise<EmailTemplate | null> => {
    const row = await db
      .selectFrom("email_templates")
      .where("tenant_id", "=", tenant_id)
      .where("template", "=", templateName)
      .selectAll()
      .executeTakeFirst();

    if (!row) {
      return null;
    }

    return emailTemplateSchema.parse(rowToTemplate(row));
  };
}
