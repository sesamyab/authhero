import type { PromptScreen } from "@authhero/adapter-interfaces";

/**
 * Mapping from screen IDs to prompt screen IDs (used for custom text).
 * Shared by the HTML routes (u2-routes.tsx) and the JSON screen API
 * (screen-api.ts) so both render paths load the same tenant overrides.
 */
const SCREEN_TO_PROMPT_MAP: Record<string, PromptScreen> = {
  identifier: "login-id",
  login: "login", // Combined identifier + password screen
  "enter-password": "login-password",
  "email-otp-challenge": "email-otp-challenge",
  "sms-otp-challenge": "email-otp-challenge", // SMS shares email-otp-challenge prompt
  signup: "signup",
  "forgot-password": "reset-password",
  "reset-password": "reset-password",
  "reset-password-code": "reset-password",
  impersonate: "login",
  "pre-signup": "signup-id",
  "pre-signup-sent": "signup",
  consent: "consent",
  "login-passwordless-identifier": "login-passwordless",
  mfa: "mfa",
  "mfa-otp": "mfa-otp",
  "mfa-phone-challenge": "mfa-phone",
  "mfa-totp-enrollment": "mfa-otp",
  "mfa-totp-challenge": "mfa-otp",
  "mfa-email": "mfa-email",
  "mfa-push": "mfa-push",
  "mfa-webauthn": "mfa-webauthn",
  "passkey-enrollment-nudge": "passkeys",
  "passkey-enrollment": "passkeys",
  "passkey-challenge": "passkeys",
  "mfa-voice": "mfa-voice",
  "mfa-phone-enrollment": "mfa-phone",
  "mfa-login-options": "mfa-login-options",
  "mfa-recovery-code": "mfa-recovery-code",
  account: "common",
  "account-profile": "common",
  "account-security": "common",
  "account-mfa-totp-enrollment": "common",
  "account-mfa-phone-enrollment": "common",
  "account-linked": "common",
  "account-delete": "common",
  "account-passkeys": "common",
  status: "status",
  // Locale defaults live under the "self-service" prompt, which is not a
  // custom-text prompt in the API, so tenant overrides go under "common".
  "self-service-app": "common",
  // Admin-facing and English-only today; mapped so it is not unaccounted for.
  "try-connection-result": "status",
  "device-flow": "device-flow",
  "device-code": "device-flow",
  "device-confirmation": "device-flow",
  "device-complete": "device-flow",
  "connect-consent": "consent",
  "connect-tenant-select": "consent",
  "email-verification": "email-verification",
  "email-verification-code": "email-verification",
  "email-verification-link-sent": "email-verification",
  organizations: "organizations",
  invitation: "invitation",
  "accept-invitation": "invitation",
};

/**
 * Screens that render tenant prompt partials (Auth0-style HTML injected at the
 * form insertion points), and where to find them. Partials are stored per
 * prompt and keyed by screen name; the prompt is the one the screen uses for
 * custom text (`SCREEN_TO_PROMPT_MAP`), and `key` is the screen name under it.
 * `key` follows Auth0's screen names where there is an equivalent and is the
 * u2 screen id otherwise.
 *
 * `identifier`, `enter-password`, `login` and `signup` read their partials
 * themselves (they validate and prefill them); the rest are attached by
 * `withPromptPartials` in the screen registry.
 *
 * Not listed on purpose: the account/self-service screens, the connect and
 * device-flow screens, consent, invitations and passkeys. They either have no
 * Auth0 prompt-partials equivalent or are not part of the sign-in form flow.
 */
export interface PromptPartialsTarget {
  prompt: PromptScreen;
  key: string;
}

const SCREEN_PARTIALS: Record<string, PromptPartialsTarget> = {
  "login-passwordless-identifier": {
    prompt: "login-passwordless",
    key: "login-passwordless-identifier",
  },
  "email-otp-challenge": {
    prompt: "email-otp-challenge",
    key: "email-otp-challenge",
  },
  "sms-otp-challenge": {
    prompt: "email-otp-challenge",
    key: "sms-otp-challenge",
  },
  "forgot-password": {
    prompt: "reset-password",
    key: "reset-password-request",
  },
  "reset-password": { prompt: "reset-password", key: "reset-password" },
  "reset-password-code": {
    prompt: "reset-password",
    key: "reset-password-code",
  },
  "mfa-totp-challenge": { prompt: "mfa-otp", key: "mfa-otp-challenge" },
  "mfa-totp-enrollment": { prompt: "mfa-otp", key: "mfa-otp-enrollment-qr" },
  "mfa-phone-challenge": { prompt: "mfa-phone", key: "mfa-phone-challenge" },
  "mfa-phone-enrollment": { prompt: "mfa-phone", key: "mfa-phone-enrollment" },
  "mfa-login-options": {
    prompt: "mfa-login-options",
    key: "mfa-login-options",
  },
};

/** Where `withPromptPartials` finds the partials for a screen, if it has any. */
export function getPartialsTargetForScreen(
  screenId: string,
): PromptPartialsTarget | undefined {
  return SCREEN_PARTIALS[screenId];
}

/** Screen ids attached by `withPromptPartials`. */
export function listPartialsScreenIds(): string[] {
  return Object.keys(SCREEN_PARTIALS);
}

export function getPromptScreenForScreen(
  screenId: string,
): PromptScreen | undefined {
  return SCREEN_TO_PROMPT_MAP[screenId];
}
