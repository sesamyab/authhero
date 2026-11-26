import { z } from "@hono/zod-openapi";

/**
 * `event.notification.message_type` values for the `custom-email-provider`
 * trigger, as documented by Auth0. AuthHero sends a subset of them.
 */
export const customEmailProviderMessageTypeSchema = z.enum([
  "verify_email",
  "verify_email_by_code",
  "reset_email",
  "reset_email_by_code",
  "welcome_email",
  "verification_code",
  "mfa_oob_code",
  "enrollment_email",
  "blocked_account",
  "stolen_credentials",
  "try_provider_configuration_email",
  "organization_invitation",
]);
export type CustomEmailProviderMessageType = z.infer<
  typeof customEmailProviderMessageTypeSchema
>;

/**
 * `event.notification.message_type` values for the `custom-phone-provider`
 * trigger, as documented by Auth0. AuthHero sends `otp_verify` (passwordless
 * and MFA challenge) and `otp_enroll` (MFA enrollment).
 */
export const customPhoneProviderMessageTypeSchema = z.enum([
  "otp_verify",
  "otp_enroll",
  "blocked_account",
  "change_password",
  "password_breach",
]);
export type CustomPhoneProviderMessageType = z.infer<
  typeof customPhoneProviderMessageTypeSchema
>;

/**
 * AuthHero extension: the hook `metadata` key listing the message types a
 * `custom-email-provider` / `custom-phone-provider` binding handles. Missing
 * or empty means every message type, which is Auth0's behaviour.
 */
export const NOTIFICATION_MESSAGE_TYPES_METADATA_KEY = "message_types";

/**
 * The message types a custom provider hook handles, read from its metadata.
 * Returns `undefined` when the hook handles every message type.
 */
export function getNotificationHookMessageTypes(
  metadata: Record<string, unknown> | undefined,
): string[] | undefined {
  const value = metadata?.[NOTIFICATION_MESSAGE_TYPES_METADATA_KEY];
  if (!Array.isArray(value)) return undefined;
  const types = value.filter((v): v is string => typeof v === "string");
  return types.length > 0 ? types : undefined;
}
