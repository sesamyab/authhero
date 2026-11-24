import { z } from "@hono/zod-openapi";

/**
 * A credential issued by a third party: an API key, client secret, access
 * token, AWS key and the like. These never legitimately start or end with
 * whitespace, but a copy-paste often adds a trailing newline or space, and
 * a password-style input hides it. Leading and trailing whitespace is
 * trimmed; inner whitespace is kept.
 *
 * Do not use this for values a person chooses, such as user passwords, SMTP
 * passwords or action secret values: there whitespace can be intentional.
 */
export function credentialString() {
  return z.string().trim();
}

/**
 * Trims the string values at `keys` in a free-form credential record, such
 * as an email provider's `credentials` or a log stream's `sink`, where the
 * schema can't name each field. Other keys and non-string values are left
 * as they are. Returns a new object; the input is not modified.
 */
export function trimCredentialFields<T extends Record<string, unknown>>(
  record: T,
  keys: readonly string[],
): T {
  const trimmed = { ...record };
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      Object.assign(trimmed, { [key]: value.trim() });
    }
  }
  return trimmed;
}
