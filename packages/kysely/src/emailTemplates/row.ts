import { Database } from "../db";

type Row = Database["email_templates"];

export function rowToTemplate(row: Row): Record<string, unknown> {
  const base: Record<string, unknown> = {
    template: row.template,
    body: row.body,
    from: row.from,
    subject: row.subject,
    syntax: row.syntax,
    includeEmailInRedirect: Boolean(row.include_email_in_redirect),
    enabled: Boolean(row.enabled),
  };
  if (row.result_url !== null && row.result_url !== undefined) {
    base.resultUrl = row.result_url;
  }
  if (
    row.url_lifetime_in_seconds !== null &&
    row.url_lifetime_in_seconds !== undefined
  ) {
    base.urlLifetimeInSeconds = row.url_lifetime_in_seconds;
  }
  return base;
}
