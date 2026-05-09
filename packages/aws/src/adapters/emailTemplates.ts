import {
  EmailTemplate,
  EmailTemplateName,
  EmailTemplatesAdapter,
  emailTemplateSchema,
} from "@authhero/adapter-interfaces";
import { DynamoDBContext, DynamoDBBaseItem } from "../types";
import { emailTemplateKeys } from "../keys";
import {
  deleteItem,
  getItem,
  putItem,
  queryItems,
  removeNullProperties,
  stripDynamoDBFields,
  updateItem,
} from "../utils";

interface EmailTemplateItem extends DynamoDBBaseItem {
  tenant_id: string;
  template: string;
  body: string;
  from: string;
  subject: string;
  syntax: string;
  result_url?: string;
  url_lifetime_in_seconds?: number;
  include_email_in_redirect: boolean;
  enabled: boolean;
}

function toEmailTemplate(item: EmailTemplateItem): EmailTemplate {
  const stripped = stripDynamoDBFields(item);
  const data = removeNullProperties({
    template: stripped.template,
    body: stripped.body,
    from: stripped.from,
    subject: stripped.subject,
    syntax: stripped.syntax,
    resultUrl: stripped.result_url,
    urlLifetimeInSeconds: stripped.url_lifetime_in_seconds,
    includeEmailInRedirect: Boolean(stripped.include_email_in_redirect),
    enabled: Boolean(stripped.enabled),
  });

  return emailTemplateSchema.parse(data);
}

export function createEmailTemplatesAdapter(
  ctx: DynamoDBContext,
): EmailTemplatesAdapter {
  return {
    async create(
      tenantId: string,
      template: EmailTemplate,
    ): Promise<EmailTemplate> {
      const now = new Date().toISOString();
      const item: EmailTemplateItem = {
        PK: emailTemplateKeys.pk(tenantId),
        SK: emailTemplateKeys.sk(template.template),
        entityType: "EMAIL_TEMPLATE",
        tenant_id: tenantId,
        template: template.template,
        body: template.body,
        from: template.from,
        subject: template.subject,
        syntax: template.syntax,
        result_url: template.resultUrl,
        url_lifetime_in_seconds: template.urlLifetimeInSeconds,
        include_email_in_redirect: template.includeEmailInRedirect,
        enabled: template.enabled,
        created_at: now,
        updated_at: now,
      };
      await putItem(ctx, item);
      return template;
    },

    async get(
      tenantId: string,
      templateName: EmailTemplateName,
    ): Promise<EmailTemplate | null> {
      const item = await getItem<EmailTemplateItem>(
        ctx,
        emailTemplateKeys.pk(tenantId),
        emailTemplateKeys.sk(templateName),
      );
      if (!item) return null;
      return toEmailTemplate(item);
    },

    async list(tenantId: string): Promise<EmailTemplate[]> {
      const { items } = await queryItems<EmailTemplateItem>(
        ctx,
        emailTemplateKeys.pk(tenantId),
        { skPrefix: emailTemplateKeys.skPrefix() },
      );
      return items.map(toEmailTemplate);
    },

    async update(
      tenantId: string,
      templateName: EmailTemplateName,
      patch: Partial<EmailTemplate>,
    ): Promise<boolean> {
      const updates: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      if (patch.body !== undefined) updates.body = patch.body;
      if (patch.from !== undefined) updates.from = patch.from;
      if (patch.subject !== undefined) updates.subject = patch.subject;
      if (patch.syntax !== undefined) updates.syntax = patch.syntax;
      if (patch.resultUrl !== undefined) updates.result_url = patch.resultUrl;
      if (patch.urlLifetimeInSeconds !== undefined)
        updates.url_lifetime_in_seconds = patch.urlLifetimeInSeconds;
      if (patch.includeEmailInRedirect !== undefined)
        updates.include_email_in_redirect = patch.includeEmailInRedirect;
      if (patch.enabled !== undefined) updates.enabled = patch.enabled;

      const existing = await getItem<EmailTemplateItem>(
        ctx,
        emailTemplateKeys.pk(tenantId),
        emailTemplateKeys.sk(templateName),
      );
      if (!existing) return false;

      await updateItem(
        ctx,
        emailTemplateKeys.pk(tenantId),
        emailTemplateKeys.sk(templateName),
        updates,
      );
      return true;
    },

    async remove(
      tenantId: string,
      templateName: EmailTemplateName,
    ): Promise<boolean> {
      const existing = await getItem<EmailTemplateItem>(
        ctx,
        emailTemplateKeys.pk(tenantId),
        emailTemplateKeys.sk(templateName),
      );
      if (!existing) return false;
      await deleteItem(
        ctx,
        emailTemplateKeys.pk(tenantId),
        emailTemplateKeys.sk(templateName),
      );
      return true;
    },
  };
}
