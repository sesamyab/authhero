/**
 * Screen Registry - maps screen IDs to their definitions
 */

import type { ScreenDefinition, ScreenContext, ScreenResult } from "./types";
import type { AccountActionOperation } from "../../../types/Hooks";
import { gatedScreen } from "./account-helpers";
import { getPrimaryUserByEmail } from "../../../helpers/users";
import { identifierScreenDefinition } from "./identifier";
import { loginScreenDefinition } from "./login";
import { emailOtpChallengeScreenDefinition } from "./email-otp-challenge";
import { smsOtpChallengeScreenDefinition } from "./sms-otp-challenge";
import { enterPasswordScreenDefinition } from "./enter-password";
import { signupScreenDefinition } from "./signup";
import { forgotPasswordScreenDefinition } from "./forgot-password";
import { resetPasswordScreenDefinition } from "./reset-password";
import { impersonateScreenDefinition } from "./impersonate";
import { loginPasswordlessIdentifierScreenDefinition } from "./login-passwordless-identifier";
import { mfaPhoneEnrollmentScreenDefinition } from "./mfa-phone-enrollment";
import { mfaPhoneChallengeScreenDefinition } from "./mfa-phone-challenge";
import { mfaTotpEnrollmentScreenDefinition } from "./mfa-totp-enrollment";
import { mfaTotpChallengeScreenDefinition } from "./mfa-totp-challenge";
import { mfaLoginOptionsScreenDefinition } from "./mfa-login-options";
import { accountScreenDefinition } from "./account";
import { accountProfileScreenDefinition } from "./account-profile";
import { accountSecurityScreenDefinition } from "./account-security";
import { accountMfaTotpEnrollmentScreenDefinition } from "./account-mfa-totp-enrollment";
import { accountMfaPhoneEnrollmentScreenDefinition } from "./account-mfa-phone-enrollment";
import { accountLinkedScreenDefinition } from "./account-linked";
import { accountDeleteScreenDefinition } from "./account-delete";
import { accountPasskeysScreenDefinition } from "./account-passkeys";
import { passkeyEnrollmentNudgeScreenDefinition } from "./passkey-enrollment-nudge";
import { passkeyEnrollmentScreenDefinition } from "./passkey-enrollment";
import { passkeyChallengeScreenDefinition } from "./passkey-challenge";
import { resetPasswordCodeScreenDefinition } from "./reset-password-code";
import { connectConsentScreenDefinition } from "./connect-consent";
import {
  deviceCodeScreenDefinition,
  deviceConfirmationScreenDefinition,
  deviceCompleteScreenDefinition,
} from "./device-flow";
import { consentScreenDefinition } from "./consent";
import { connectTenantSelectScreenDefinition } from "./connect-tenant-select";
import { tryConnectionResultScreenDefinition } from "./try-connection-result";
import { acceptInvitationScreenDefinition } from "./accept-invitation";
import {
  emailVerificationCodeScreenDefinition,
  emailVerificationLinkSentScreenDefinition,
} from "./email-verification";

/**
 * Fire the `pre-account-action` trigger when the user opens a screen that
 * starts an account operation. Operations that are a button on a shared
 * screen (removing an MFA factor or passkey, unlinking an identity) are gated
 * in that screen's POST handler instead.
 */
function withAccountActionGate(
  definition: ScreenDefinition,
  operation: AccountActionOperation,
  options?: Parameters<typeof gatedScreen>[2],
): ScreenDefinition {
  return {
    ...definition,
    handler: {
      ...definition.handler,
      get: gatedScreen(operation, definition.handler.get, options),
    },
  };
}

/**
 * Password reset starts before sign-in, so the user comes from the identifier
 * entered so far (if any) rather than the session.
 */
async function resetPasswordUser(context: ScreenContext) {
  const email = context.prefill?.username;
  if (typeof email !== "string" || !email) return undefined;
  return getPrimaryUserByEmail({
    userAdapter: context.ctx.env.data.users,
    tenant_id: context.tenant.id,
    email,
  });
}

/**
 * Registry of all built-in screens
 */
export const screenRegistry: Map<string, ScreenDefinition> = new Map([
  ["identifier", identifierScreenDefinition],
  ["login", loginScreenDefinition],
  ["email-otp-challenge", emailOtpChallengeScreenDefinition],
  ["sms-otp-challenge", smsOtpChallengeScreenDefinition],
  ["enter-password", enterPasswordScreenDefinition],
  ["signup", signupScreenDefinition],
  [
    "forgot-password",
    withAccountActionGate(forgotPasswordScreenDefinition, "reset-password", {
      user: resetPasswordUser,
    }),
  ],
  ["reset-password", resetPasswordScreenDefinition],
  ["impersonate", impersonateScreenDefinition],
  [
    "login-passwordless-identifier",
    loginPasswordlessIdentifierScreenDefinition,
  ],
  ["mfa-phone-enrollment", mfaPhoneEnrollmentScreenDefinition],
  ["mfa-phone-challenge", mfaPhoneChallengeScreenDefinition],
  ["mfa-totp-enrollment", mfaTotpEnrollmentScreenDefinition],
  ["mfa-totp-challenge", mfaTotpChallengeScreenDefinition],
  ["mfa-login-options", mfaLoginOptionsScreenDefinition],
  ["account", accountScreenDefinition],
  [
    "account-profile",
    withAccountActionGate(accountProfileScreenDefinition, "update-profile"),
  ],
  ["account-security", accountSecurityScreenDefinition],
  [
    "account-mfa-totp-enrollment",
    withAccountActionGate(
      accountMfaTotpEnrollmentScreenDefinition,
      "enroll-mfa",
      { details: { factor: "totp" } },
    ),
  ],
  [
    "account-mfa-phone-enrollment",
    withAccountActionGate(
      accountMfaPhoneEnrollmentScreenDefinition,
      "enroll-mfa",
      { details: { factor: "phone" } },
    ),
  ],
  ["account-linked", accountLinkedScreenDefinition],
  [
    "account-delete",
    withAccountActionGate(accountDeleteScreenDefinition, "delete-account"),
  ],
  ["account-passkeys", accountPasskeysScreenDefinition],
  ["passkey-enrollment-nudge", passkeyEnrollmentNudgeScreenDefinition],
  ["passkey-enrollment", passkeyEnrollmentScreenDefinition],
  ["passkey-challenge", passkeyChallengeScreenDefinition],
  ["reset-password-code", resetPasswordCodeScreenDefinition],
  ["connect-consent", connectConsentScreenDefinition],
  ["consent", consentScreenDefinition],
  ["device-code", deviceCodeScreenDefinition],
  ["device-confirmation", deviceConfirmationScreenDefinition],
  ["device-complete", deviceCompleteScreenDefinition],
  ["connect-tenant-select", connectTenantSelectScreenDefinition],
  ["try-connection-result", tryConnectionResultScreenDefinition],
  ["accept-invitation", acceptInvitationScreenDefinition],
  ["email-verification-code", emailVerificationCodeScreenDefinition],
  ["email-verification-link-sent", emailVerificationLinkSentScreenDefinition],
]);

/**
 * Get a screen definition by ID
 */
export function getScreenDefinition(
  screenId: string,
): ScreenDefinition | undefined {
  return screenRegistry.get(screenId);
}

/**
 * Get a screen by ID
 *
 * @param screenId - The screen ID (e.g., "identifier", "email-otp-challenge")
 * @param context - The screen context with tenant, client, branding, etc.
 * @returns The screen result promise or undefined if not found
 */
export function getScreen(
  screenId: string,
  context: ScreenContext,
): Promise<ScreenResult> | undefined {
  const definition = screenRegistry.get(screenId);
  if (!definition) {
    return undefined;
  }
  return definition.handler.get(context);
}

/**
 * List all available screen IDs
 */
export function listScreenIds(): string[] {
  return Array.from(screenRegistry.keys());
}

/**
 * Check if a screen ID is valid
 */
export function isValidScreenId(screenId: string): boolean {
  return screenRegistry.has(screenId);
}
