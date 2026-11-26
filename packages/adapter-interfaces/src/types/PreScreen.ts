/**
 * The `pre-screen` trigger (AuthHero extension; Auth0 has no pre-login
 * trigger) runs before a universal-login screen is shown (`render`) and when
 * it is submitted (`submit`). Screens are named with Auth0's Universal Login
 * vocabulary (the prompt and screen names of Advanced Customizations for
 * Universal Login) where Auth0 has the screen; AuthHero-only screens have
 * names of their own and `auth0: false`.
 */
export const PRE_SCREEN_TRIGGER_ID = "pre-screen";

export type PreScreenPhase = "render" | "submit";

export interface PreScreenScreen {
  /** `event.screen.name` */
  name: string;
  /** `event.prompt.name` */
  prompt: string;
  /** Whether Auth0's Universal Login has a screen with this name. */
  auth0: boolean;
  description: string;
}

export const PRE_SCREEN_SCREENS: readonly PreScreenScreen[] = [
  // Sign-in
  {
    name: "login-id",
    prompt: "login-id",
    auth0: true,
    description: "Identifier step of identifier-first login",
  },
  {
    name: "login",
    prompt: "login",
    auth0: true,
    description: "Combined identifier and password login",
  },
  {
    name: "login-password",
    prompt: "login-password",
    auth0: true,
    description: "Password step after the identifier",
  },
  {
    name: "login-passwordless-identifier",
    prompt: "login-passwordless",
    auth0: false,
    description: "Identifier step of a passwordless-only login",
  },
  {
    name: "login-passwordless-email-code",
    prompt: "login-passwordless",
    auth0: true,
    description: "Enter the code sent by email",
  },
  {
    name: "login-passwordless-sms-otp",
    prompt: "login-passwordless",
    auth0: true,
    description: "Enter the code sent by text message",
  },
  {
    name: "magic-link-sent",
    prompt: "login-passwordless",
    auth0: false,
    description: "Sign-in link sent by email",
  },
  {
    name: "passkey-challenge",
    prompt: "passkeys",
    auth0: false,
    description: "Sign in with a passkey",
  },
  {
    name: "email-verification-code",
    prompt: "email-verification",
    auth0: false,
    description: "Verify the email address with a code during login",
  },
  {
    name: "email-verification-link-sent",
    prompt: "email-verification",
    auth0: false,
    description: "Verification link sent during login",
  },
  {
    name: "impersonate",
    prompt: "impersonate",
    auth0: false,
    description: "Choose a user to impersonate",
  },
  // Sign-up
  {
    name: "signup",
    prompt: "signup",
    auth0: true,
    description: "Sign-up form",
  },
  // Password reset
  {
    name: "reset-password-request",
    prompt: "reset-password",
    auth0: true,
    description: "Ask for a password reset",
  },
  {
    name: "reset-password-code",
    prompt: "reset-password",
    auth0: false,
    description: "Enter the password reset code",
  },
  {
    name: "reset-password",
    prompt: "reset-password",
    auth0: true,
    description: "Choose a new password",
  },
  // MFA and passkeys
  {
    name: "mfa-login-options",
    prompt: "mfa",
    auth0: true,
    description: "Choose an MFA method",
  },
  {
    name: "mfa-otp-challenge",
    prompt: "mfa-otp",
    auth0: true,
    description: "Enter an authenticator app code",
  },
  {
    name: "mfa-otp-enrollment-qr",
    prompt: "mfa-otp",
    auth0: true,
    description: "Enroll an authenticator app",
  },
  {
    name: "mfa-phone-challenge",
    prompt: "mfa-phone",
    auth0: true,
    description: "Enter a code sent to the phone",
  },
  {
    name: "mfa-phone-enrollment",
    prompt: "mfa-phone",
    auth0: true,
    description: "Enroll a phone number",
  },
  {
    name: "passkey-enrollment",
    prompt: "passkeys",
    auth0: true,
    description: "Create a passkey",
  },
  {
    name: "passkey-enrollment-nudge",
    prompt: "passkeys",
    auth0: false,
    description: "Offer to create a passkey after login",
  },
  // Consent, device flow, invitations
  {
    name: "consent",
    prompt: "consent",
    auth0: true,
    description: "Consent to the requested scopes",
  },
  {
    name: "device-code-activation",
    prompt: "device-flow",
    auth0: true,
    description: "Enter the device code",
  },
  {
    name: "device-code-confirmation",
    prompt: "device-flow",
    auth0: true,
    description: "Confirm the device",
  },
  {
    name: "device-code-activation-allowed",
    prompt: "device-flow",
    auth0: true,
    description: "Device activated",
  },
  {
    name: "accept-invitation",
    prompt: "invitation",
    auth0: true,
    description: "Accept an organization invitation",
  },
  // Account (self-service) pages
  {
    name: "account",
    prompt: "account",
    auth0: false,
    description: "Account overview",
  },
  {
    name: "account-profile",
    prompt: "account",
    auth0: false,
    description: "Edit profile",
  },
  {
    name: "account-change-email",
    prompt: "account",
    auth0: false,
    description: "Change email address",
  },
  {
    name: "account-change-email-verify",
    prompt: "account",
    auth0: false,
    description: "Verify the new email address",
  },
  {
    name: "account-security",
    prompt: "account",
    auth0: false,
    description: "MFA factors (remove a factor)",
  },
  {
    name: "account-mfa-totp-enrollment",
    prompt: "account",
    auth0: false,
    description: "Enroll an authenticator app from the account page",
  },
  {
    name: "account-mfa-phone-enrollment",
    prompt: "account",
    auth0: false,
    description: "Enroll a phone from the account page",
  },
  {
    name: "account-linked",
    prompt: "account",
    auth0: false,
    description: "Linked identities (unlink an identity)",
  },
  {
    name: "account-passkeys",
    prompt: "account",
    auth0: false,
    description: "Passkeys (add or remove a passkey)",
  },
  {
    name: "account-delete",
    prompt: "account",
    auth0: false,
    description: "Delete the account",
  },
  // Connect and self-service setup
  {
    name: "connect-consent",
    prompt: "connect",
    auth0: false,
    description: "Approve connecting an application",
  },
  {
    name: "connect-tenant-select",
    prompt: "connect",
    auth0: false,
    description: "Choose the tenant to connect",
  },
  {
    name: "self-service-app",
    prompt: "self-service",
    auth0: false,
    description: "Self-service application setup",
  },
  // Status pages
  {
    name: "invalid-session",
    prompt: "status",
    auth0: false,
    description: "Login session expired or invalid",
  },
  {
    name: "try-connection-result",
    prompt: "status",
    auth0: false,
    description: "Result of testing a connection",
  },
];

export function getPreScreenScreen(name: string): PreScreenScreen | undefined {
  return PRE_SCREEN_SCREENS.find((screen) => screen.name === name);
}

/**
 * Operations a submission can perform, carried as `event.operation` in the
 * submit phase (the operation names of the former `pre-account-action`
 * trigger).
 */
export const PRE_SCREEN_OPERATIONS = [
  "change-email",
  "update-profile",
  "reset-password",
  "enroll-mfa",
  "remove-mfa",
  "enroll-passkey",
  "remove-passkey",
  "unlink-identity",
  "delete-account",
] as const;
export type PreScreenOperation = (typeof PRE_SCREEN_OPERATIONS)[number];

/**
 * Hook `metadata` key listing the screen names a `pre-screen` binding runs
 * for. Missing or empty means every screen (like `message_types` on the
 * custom provider triggers).
 */
export const PRE_SCREEN_SCREENS_METADATA_KEY = "screens";

/**
 * Hook `metadata` key: `true` makes a failing action deny the screen in the
 * render phase too. The submit phase always fails closed.
 */
export const PRE_SCREEN_FAIL_CLOSED_METADATA_KEY = "fail_closed";

/** The screens a `pre-screen` hook runs for, or `undefined` for every screen. */
export function getPreScreenHookScreens(
  metadata: Record<string, unknown> | undefined,
): string[] | undefined {
  const value = metadata?.[PRE_SCREEN_SCREENS_METADATA_KEY];
  if (!Array.isArray(value)) return undefined;
  const screens = value.filter((v): v is string => typeof v === "string");
  return screens.length > 0 ? screens : undefined;
}

export function isPreScreenHookFailClosed(
  metadata: Record<string, unknown> | undefined,
): boolean {
  const value = metadata?.[PRE_SCREEN_FAIL_CLOSED_METADATA_KEY];
  return value === true || value === "true";
}

/**
 * Screen names in a hook's `metadata.screens` that aren't `pre-screen`
 * screens. A typo would otherwise silently stop the binding from running.
 */
export function findUnknownPreScreenScreens(
  metadata: Record<string, unknown> | undefined,
): string[] {
  const value = metadata?.[PRE_SCREEN_SCREENS_METADATA_KEY];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return [String(value)];
  // Non-string entries are unknown, not coerced: the runtime ignores them, so
  // e.g. `[["login-id"]]` would otherwise pass here and then match every
  // screen.
  return value
    .filter((v) => typeof v !== "string" || !getPreScreenScreen(v))
    .map((v) => (typeof v === "string" ? v : JSON.stringify(v)));
}

/**
 * Triggers that were removed. Hooks stored with one of these ids are ignored
 * (with a log line) wherever stored hooks are read back in bulk, instead of
 * failing validation.
 */
export const RETIRED_HOOK_TRIGGER_IDS: readonly string[] = [
  // Replaced by `pre-screen`.
  "pre-account-action",
];

export function isRetiredHookTrigger(triggerId: unknown): boolean {
  return (
    typeof triggerId === "string" &&
    RETIRED_HOOK_TRIGGER_IDS.includes(triggerId)
  );
}
