import { EmailTemplate, EmailTemplateName } from "../types";

export interface EmailTemplatesAdapter {
  get: (
    tenant_id: string,
    templateName: EmailTemplateName,
  ) => Promise<EmailTemplate | null>;
  list: (tenant_id: string) => Promise<EmailTemplate[]>;
  create: (
    tenant_id: string,
    template: EmailTemplate,
  ) => Promise<EmailTemplate>;
  update: (
    tenant_id: string,
    templateName: EmailTemplateName,
    template: Partial<EmailTemplate>,
  ) => Promise<boolean>;
  remove: (
    tenant_id: string,
    templateName: EmailTemplateName,
  ) => Promise<boolean>;
}
