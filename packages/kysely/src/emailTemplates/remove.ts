import { Kysely } from "kysely";
import { EmailTemplateName } from "@authhero/adapter-interfaces";
import { Database } from "../db";

export function remove(db: Kysely<Database>) {
  return async (
    tenant_id: string,
    templateName: EmailTemplateName,
  ): Promise<boolean> => {
    const result = await db
      .deleteFrom("email_templates")
      .where("tenant_id", "=", tenant_id)
      .where("template", "=", templateName)
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0) > 0;
  };
}
