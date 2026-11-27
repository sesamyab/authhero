/**
 * Magic Link Sent screen
 *
 * Shown after a magic link has been sent to the user's email.
 * Tells the user to check their email and click the link to log in.
 *
 * Corresponds to: /u2/login/magic-link-sent
 */

import type { UiScreen, FormNodeComponent } from "@authhero/adapter-interfaces";
import { isDatabaseConnectionStrategy } from "@authhero/adapter-interfaces";
import type { ScreenContext, ScreenResult, ScreenDefinition } from "./types";
import { escapeHtml } from "../sanitization-utils";
import { createTranslation } from "../../../i18n";
import { loginOtpResendResult } from "./login-otp";

/**
 * Create the magic-link-sent screen
 */
export async function magicLinkSentScreen(
  context: ScreenContext,
): Promise<ScreenResult> {
  const { branding, state, messages, data, customText, routePrefix } = context;

  const locale = context.language || "en";
  const { m } = createTranslation(
    "magic-link-sent",
    "magic-link-sent",
    locale,
    customText,
  );
  const { m: common } = createTranslation(
    "common",
    "common",
    locale,
    customText,
  );

  const email = data?.email as string | undefined;
  const maskedEmail = email ? email.replace(/(.{2})(.*)(@.*)/, "$1***$3") : "";

  const description = maskedEmail
    ? m.description({
        username: `<strong>${escapeHtml(maskedEmail)}</strong>`,
      })
    : m.defaultDescription();

  const components: FormNodeComponent[] = [
    // Spam reminder
    {
      id: "spam-reminder",
      type: "RICH_TEXT",
      category: "BLOCK",
      visible: true,
      config: {
        content: `<p>${m.spamText()}</p>`,
      },
      order: 0,
    },
    // Resend link button
    {
      id: "resend",
      type: "RESEND_BUTTON",
      category: "BLOCK",
      visible: true,
      config: {
        text: m.resendText(),
      },
      order: 1,
    },
  ];

  // Back link
  const hasPasswordConnection = context.connections.some((c) =>
    isDatabaseConnectionStrategy(c.strategy),
  );
  const backPath = hasPasswordConnection
    ? `${routePrefix}/login/identifier`
    : `${routePrefix}/login/login-passwordless-identifier`;

  const screen: UiScreen = {
    name: "magic-link-sent",
    action: `${routePrefix}/login/magic-link-sent?state=${encodeURIComponent(state)}`,
    method: "POST",
    title: m.title(),
    description,
    components,
    messages: messages?.map((msg) => ({ text: msg.text, type: msg.type })),
    links: [
      {
        id: "back",
        text: "",
        linkText: common.backToLoginText(),
        href: `${backPath}?state=${encodeURIComponent(state)}`,
      },
    ],
  };

  return {
    screen,
    branding,
  };
}

/**
 * Screen definition for the magic-link-sent screen. The only action is the
 * resend button; any other POST re-renders the screen.
 */
export const magicLinkSentScreenDefinition: ScreenDefinition = {
  id: "magic-link-sent",
  name: "Magic Link Sent",
  description: "Check-your-email screen shown after a magic link is sent",
  handler: {
    get: magicLinkSentScreen,
    post: async (context, data) => {
      if (data.action !== "resend") {
        return { screen: await magicLinkSentScreen(context) };
      }

      const locale = context.language || "en";
      const { m } = createTranslation(
        "magic-link-sent",
        "magic-link-sent",
        locale,
        context.customText,
      );

      return loginOtpResendResult(context, {
        render: magicLinkSentScreen,
        magicLink: true,
        successText: m.resendSuccess(),
        failedText: m.resendFailed(),
        // No dedicated session-expired copy on this prompt
        expiredText: m.resendFailed(),
      });
    },
  },
};
