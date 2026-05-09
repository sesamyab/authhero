import type { EmailTemplateName } from "@authhero/adapter-interfaces";
import { defaultBodies } from "./compiled";
import { defaultSubjects } from "./subjects";

export interface DefaultTemplate {
  subject: string;
  body: string;
}

export function getDefaultTemplate(
  name: EmailTemplateName,
): DefaultTemplate | null {
  const body = defaultBodies[name];
  const subject = defaultSubjects[name];
  if (!body || !subject) return null;
  return { subject, body };
}
