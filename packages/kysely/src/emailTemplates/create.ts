import { EmailTemplate } from "@authhero/adapter-interfaces";
import { Kysely } from "kysely";
import { Database } from "../db";

export function create(db: Kysely<Database>) {
  return async (
    tenant_id: string,
    template: EmailTemplate,
  ): Promise<EmailTemplate> => {
    const now = new Date().toISOString();

    await db
      .insertInto("email_templates")
      .values({
        tenant_id,
        template: template.template,
        body: template.body,
        from: template.from,
        subject: template.subject,
        syntax: template.syntax,
        result_url: template.resultUrl ?? null,
        url_lifetime_in_seconds: template.urlLifetimeInSeconds ?? null,
        include_email_in_redirect: template.includeEmailInRedirect ? 1 : 0,
        enabled: template.enabled ? 1 : 0,
        created_at: now,
        updated_at: now,
      })
      .execute();

    return template;
  };
}
