/**
 * Sample screens for the full-page Universal Login preview.
 *
 * These mirror the shapes the screen registry produces at runtime, but with
 * static placeholder content so the preview endpoint can render a full page
 * without a real login session. They intentionally use inert `#` actions and
 * links — the preview is for visual layout, not interaction.
 */

export const PREVIEW_SCREEN_IDS = [
  "login",
  "identifier",
  "password",
  "signup",
  "otp",
  "mfa",
  "consent",
  "error",
] as const;

export type PreviewScreenId = (typeof PREVIEW_SCREEN_IDS)[number];

interface PreviewComponent {
  id: string;
  type: string;
  category: "FIELD" | "BLOCK" | "WIDGET";
  visible: boolean;
  label?: string;
  config?: Record<string, unknown>;
  required?: boolean;
  sensitive?: boolean;
  order: number;
  messages?: Array<{ text: string; type: "error" | "success" }>;
}

interface PreviewScreen {
  name: string;
  action: string;
  method: string;
  title?: string;
  description?: string;
  components: PreviewComponent[];
  links?: Array<{
    id?: string;
    text: string;
    linkText?: string;
    href: string;
  }>;
  messages?: Array<{ text: string; type: "error" | "success" }>;
}

const socialButtons: PreviewComponent = {
  id: "social-buttons",
  type: "SOCIAL",
  category: "FIELD",
  visible: true,
  config: { providers: ["google-oauth2"] },
  order: 0,
};

const divider: PreviewComponent = {
  id: "divider",
  type: "DIVIDER",
  category: "BLOCK",
  visible: true,
  order: 1,
};

const emailField: PreviewComponent = {
  id: "username",
  type: "EMAIL",
  category: "FIELD",
  visible: true,
  label: "Email address",
  config: { placeholder: "name@example.com" },
  required: true,
  order: 2,
};

function passwordField(order: number): PreviewComponent {
  return {
    id: "password",
    type: "PASSWORD",
    category: "FIELD",
    visible: true,
    label: "Password",
    config: { placeholder: "Enter your password" },
    required: true,
    sensitive: true,
    order,
  };
}

function submit(text: string, order: number): PreviewComponent {
  return {
    id: "submit",
    type: "NEXT_BUTTON",
    category: "BLOCK",
    visible: true,
    config: { text },
    order,
  };
}

/**
 * Build a sample screen object for the given preview screen id. Falls back to
 * the identifier/login screen for unknown ids.
 */
export function buildPreviewScreen(screenId: string): PreviewScreen {
  switch (screenId) {
    case "signup":
      return {
        name: "signup",
        action: "#",
        method: "POST",
        title: "Create account",
        description: "Sign up to get started",
        components: [
          socialButtons,
          divider,
          emailField,
          passwordField(3),
          submit("Sign up", 4),
        ],
        links: [
          {
            id: "login",
            text: "Already have an account?",
            linkText: "Sign in",
            href: "#",
          },
        ],
      };
    case "password":
      return {
        name: "login-password",
        action: "#",
        method: "POST",
        title: "Enter your password",
        description: "Signing in as <strong>user@example.com</strong>",
        components: [passwordField(0), submit("Continue", 1)],
        links: [
          {
            id: "forgot",
            text: "Forgot your password?",
            linkText: "Reset it",
            href: "#",
          },
        ],
      };
    case "otp":
      return {
        name: "email-otp-challenge",
        action: "#",
        method: "POST",
        title: "Check your email",
        description: "We sent a code to <strong>user@example.com</strong>",
        components: [
          {
            id: "code",
            type: "TEXT",
            category: "FIELD",
            visible: true,
            label: "Code",
            config: { placeholder: "Enter the code", max_length: 6 },
            required: true,
            order: 0,
          },
          submit("Continue", 1),
          {
            id: "resend",
            type: "RESEND_BUTTON",
            category: "BLOCK",
            visible: true,
            config: { text: "Resend code" },
            order: 2,
          },
        ],
      };
    case "mfa":
      return {
        name: "mfa-totp-challenge",
        action: "#",
        method: "POST",
        title: "Verify your identity",
        description: "Enter the code from your authenticator app",
        components: [
          {
            id: "code",
            type: "TEXT",
            category: "FIELD",
            visible: true,
            label: "Authenticator code",
            config: { placeholder: "Authenticator code", max_length: 6 },
            required: true,
            order: 0,
          },
          submit("Continue", 1),
        ],
      };
    case "consent":
      return {
        name: "consent",
        action: "#",
        method: "POST",
        title: "Authorize Example App",
        description: "Example App wants to access your account",
        components: [
          {
            id: "consent-summary",
            type: "RICH_TEXT",
            category: "BLOCK",
            visible: true,
            config: {
              content:
                '<div style="display:flex;flex-direction:column;gap:12px;padding:16px;border:1px solid #e5e7eb;border-radius:8px;background:#f9fafb">' +
                '<div style="font-size:18px;font-weight:600;color:#111827">Example App</div>' +
                '<div style="font-size:14px;color:#374151">Access your account as <span style="font-weight:500">user@example.com</span></div>' +
                '<div style="font-size:13px;color:#6b7280;margin-top:8px">Example App will be able to:</div>' +
                '<ul style="margin:0;padding-left:20px"><li>View your profile</li><li>View your email address</li></ul></div>',
            },
            order: 0,
          },
          submit("Allow", 1),
        ],
        links: [{ id: "deny", text: "Cancel", href: "#" }],
      };
    case "error":
      return {
        name: "login-password",
        action: "#",
        method: "POST",
        title: "Enter your password",
        description: "Signing in as <strong>user@example.com</strong>",
        components: [
          {
            ...passwordField(0),
            messages: [{ text: "Wrong email or password", type: "error" }],
          },
          submit("Continue", 1),
        ],
        messages: [
          {
            text: "We couldn't sign you in. Check your details and try again.",
            type: "error",
          },
        ],
        links: [
          {
            id: "forgot",
            text: "Forgot your password?",
            linkText: "Reset it",
            href: "#",
          },
        ],
      };
    case "login":
    case "identifier":
    default:
      return {
        name: "login-id",
        action: "#",
        method: "POST",
        title: "Welcome",
        description: "Sign in to continue",
        components: [socialButtons, divider, emailField, submit("Continue", 3)],
        links: [
          {
            id: "signup",
            text: "Don't have an account?",
            linkText: "Sign up",
            href: "#",
          },
        ],
      };
  }
}
