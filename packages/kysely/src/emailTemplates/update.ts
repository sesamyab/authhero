import {
  EmailTemplate,
  EmailTemplateName,
} from "@authhero/adapter-interfaces";
import { Kysely } from "kysely";
import { Database } from "../db";

type Row = Database["email_templates"];
type UpdateSet = Partial<Omit<Row, "tenant_id" | "template" | "created_at">>;

export function update(db: Kysely<Database>) {
  return async (
    tenant_id: string,
    templateName: EmailTemplateName,
    patch: Partial<EmailTemplate>,
  ): Promise<boolean> => {
    const set: UpdateSet = {};

    if (patch.body !== undefined) set.body = patch.body;
    if (patch.from !== undefined) set.from = patch.from;
    if (patch.subject !== undefined) set.subject = patch.subject;
    if (patch.syntax !== undefined) set.syntax = patch.syntax;
    if (patch.resultUrl !== undefined) set.result_url = patch.resultUrl;
    if (patch.urlLifetimeInSeconds !== undefined) {
      set.url_lifetime_in_seconds = patch.urlLifetimeInSeconds;
    }
    if (patch.includeEmailInRedirect !== undefined) {
      set.include_email_in_redirect = patch.includeEmailInRedirect ? 1 : 0;
    }
    if (patch.enabled !== undefined) {
      set.enabled = patch.enabled ? 1 : 0;
    }

    if (Object.keys(set).length === 0) {
      const existing = await db
        .selectFrom("email_templates")
        .where("tenant_id", "=", tenant_id)
        .where("template", "=", templateName)
        .select("template")
        .executeTakeFirst();
      return existing !== undefined;
    }

    set.updated_at = new Date().toISOString();

    const result = await db
      .updateTable("email_templates")
      .set(set)
      .where("tenant_id", "=", tenant_id)
      .where("template", "=", templateName)
      .executeTakeFirst();

    return Number(result.numUpdatedRows ?? 0) > 0;
  };
}
