import { useWatch } from "react-hook-form";
import { AutocompleteArrayInput } from "@/components/admin";

/** Auth0's custom provider triggers: the bound action delivers messages itself. */
export const NOTIFICATION_TRIGGER_IDS = [
  "custom-email-provider",
  "custom-phone-provider",
] as const;

export function isNotificationTrigger(triggerId: unknown): boolean {
  return NOTIFICATION_TRIGGER_IDS.some((id) => id === triggerId);
}

/**
 * Auth0's `message_type` values. The ones AuthHero sends today come first;
 * the rest are accepted so an Auth0 configuration keeps working.
 */
const EMAIL_MESSAGE_TYPES = [
  { id: "verification_code", name: "Passwordless code or link" },
  { id: "verify_email", name: "Email verification link" },
  { id: "verify_email_by_code", name: "Email verification code" },
  { id: "reset_email", name: "Password reset link" },
  { id: "reset_email_by_code", name: "Password reset code" },
  { id: "organization_invitation", name: "Organization invitation" },
  { id: "try_provider_configuration_email", name: "Test email" },
  { id: "welcome_email", name: "Welcome email (not sent yet)" },
  { id: "mfa_oob_code", name: "MFA email code (not sent yet)" },
  { id: "enrollment_email", name: "MFA enrollment email (not sent yet)" },
  { id: "blocked_account", name: "Blocked account (not sent yet)" },
  { id: "stolen_credentials", name: "Breached password (not sent yet)" },
];

const PHONE_MESSAGE_TYPES = [
  { id: "otp_verify", name: "Passwordless and MFA codes" },
  { id: "otp_enroll", name: "MFA enrollment codes" },
  { id: "blocked_account", name: "Blocked account (not sent yet)" },
  { id: "change_password", name: "Change password (not sent yet)" },
  { id: "password_breach", name: "Breached password (not sent yet)" },
];

export function getMessageTypeChoices(triggerId: unknown) {
  if (triggerId === "custom-email-provider") return EMAIL_MESSAGE_TYPES;
  if (triggerId === "custom-phone-provider") return PHONE_MESSAGE_TYPES;
  return [];
}

/** "All message types" or the names of the selected ones. */
export function describeMessageTypes(
  triggerId: unknown,
  metadata: unknown,
): string {
  const value =
    metadata && typeof metadata === "object"
      ? Reflect.get(metadata, "message_types")
      : undefined;
  const selected = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
  if (selected.length === 0) return "All message types";
  const choices = getMessageTypeChoices(triggerId);
  return selected
    .map((id) => choices.find((c) => c.id === id)?.name ?? id)
    .join(", ");
}

/**
 * AuthHero extension on custom provider bindings, borrowed from Clerk's
 * per-template switch: pick which message types this action delivers. Stored
 * on the hook as `metadata.message_types`.
 */
export function NotificationMessageTypesInput() {
  const triggerId = useWatch({ name: "trigger_id" });
  if (!isNotificationTrigger(triggerId)) return null;
  const normalProvider =
    triggerId === "custom-email-provider"
      ? "the email provider"
      : "the SMS connection";
  return (
    <AutocompleteArrayInput
      source="metadata.message_types"
      label="Message types delivered by this action"
      choices={getMessageTypeChoices(triggerId)}
      helperText={`Leave empty to deliver every message with this action (Auth0's behaviour). Message types you don't select keep going through ${normalProvider}.`}
    />
  );
}
