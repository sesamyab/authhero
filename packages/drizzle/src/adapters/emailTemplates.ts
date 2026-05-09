import { and, eq } from "drizzle-orm";
import type {
  EmailTemplate,
  EmailTemplateName,
} from "@authhero/adapter-interfaces";
import { emailTemplates } from "../schema/sqlite";
import { removeNullProperties } from "../helpers/transform";
import type { DrizzleDb } from "./types";

type Row = typeof emailTemplates.$inferSelect;

function rowToTemplate(row: Row): EmailTemplate {
  const base: EmailTemplate = {
    template: row.template as EmailTemplateName,
    body: row.body,
    from: row.from,
    subject: row.subject,
    syntax: "liquid",
    includeEmailInRedirect: Boolean(row.include_email_in_redirect),
    enabled: Boolean(row.enabled),
  };
  return removeNullProperties({
    ...base,
    resultUrl: row.result_url ?? undefined,
    urlLifetimeInSeconds: row.url_lifetime_in_seconds ?? undefined,
  });
}

export function createEmailTemplatesAdapter(db: DrizzleDb) {
  return {
    async get(
      tenant_id: string,
      templateName: EmailTemplateName,
    ): Promise<EmailTemplate | null> {
      const row = await db
        .select()
        .from(emailTemplates)
        .where(
          and(
            eq(emailTemplates.tenant_id, tenant_id),
            eq(emailTemplates.template, templateName),
          ),
        )
        .get();
      return row ? rowToTemplate(row) : null;
    },

    async list(tenant_id: string): Promise<EmailTemplate[]> {
      const rows = await db
        .select()
        .from(emailTemplates)
        .where(eq(emailTemplates.tenant_id, tenant_id))
        .all();
      return rows.map(rowToTemplate);
    },

    async create(
      tenant_id: string,
      template: EmailTemplate,
    ): Promise<EmailTemplate> {
      const now = new Date().toISOString();
      await db.insert(emailTemplates).values({
        tenant_id,
        template: template.template,
        body: template.body,
        from: template.from,
        subject: template.subject,
        syntax: template.syntax,
        result_url: template.resultUrl ?? null,
        url_lifetime_in_seconds: template.urlLifetimeInSeconds ?? null,
        include_email_in_redirect: template.includeEmailInRedirect,
        enabled: template.enabled,
        created_at: now,
        updated_at: now,
      });
      return template;
    },

    async update(
      tenant_id: string,
      templateName: EmailTemplateName,
      patch: Partial<EmailTemplate>,
    ): Promise<boolean> {
      const set: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      if (patch.body !== undefined) set.body = patch.body;
      if (patch.from !== undefined) set.from = patch.from;
      if (patch.subject !== undefined) set.subject = patch.subject;
      if (patch.syntax !== undefined) set.syntax = patch.syntax;
      if (patch.resultUrl !== undefined) set.result_url = patch.resultUrl;
      if (patch.urlLifetimeInSeconds !== undefined)
        set.url_lifetime_in_seconds = patch.urlLifetimeInSeconds;
      if (patch.includeEmailInRedirect !== undefined)
        set.include_email_in_redirect = patch.includeEmailInRedirect;
      if (patch.enabled !== undefined) set.enabled = patch.enabled;

      const result = await db
        .update(emailTemplates)
        .set(set)
        .where(
          and(
            eq(emailTemplates.tenant_id, tenant_id),
            eq(emailTemplates.template, templateName),
          ),
        )
        .run();

      return Number(result.changes ?? 0) > 0;
    },

    async remove(
      tenant_id: string,
      templateName: EmailTemplateName,
    ): Promise<boolean> {
      const result = await db
        .delete(emailTemplates)
        .where(
          and(
            eq(emailTemplates.tenant_id, tenant_id),
            eq(emailTemplates.template, templateName),
          ),
        )
        .run();
      return Number(result.changes ?? 0) > 0;
    },
  };
}
