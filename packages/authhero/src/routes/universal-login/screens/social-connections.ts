/**
 * Which of a client's connections the u2 login screens show as social /
 * enterprise buttons. Same rules as the legacy /u identifier page:
 *
 * - Email, SMS and database connections are form inputs, not buttons.
 * - `show_as_button: false` always hides a connection.
 * - Connections with `domain_aliases` are reached by home realm discovery
 *   (email-domain routing) and hidden unless `show_as_button: true`, on
 *   screens that do that routing (the identifier screen).
 * - Strategies that refuse embedded browsers (Google) are hidden in in-app
 *   browsers, where the provider would reject the sign-in.
 *
 * Unlike /u, strategies without a built-in handler (custom OAuth2/OIDC set up
 * through the `STRATEGIES` env) are kept: they fall back to their name and a
 * generic icon.
 */

import type { Connection } from "@authhero/adapter-interfaces";
import {
  Strategy,
  isDatabaseConnectionStrategy,
} from "@authhero/adapter-interfaces";
import { BUILTIN_STRATEGIES } from "../../../strategies";
import { detectEmbeddedBrowser } from "../../../utils/embedded-browser";

export function isFormConnection(connection: Connection): boolean {
  return (
    connection.strategy === Strategy.EMAIL ||
    connection.strategy === Strategy.SMS ||
    isDatabaseConnectionStrategy(connection.strategy)
  );
}

export function isShownAsButton(
  connection: Connection,
  options: { embeddedBrowser: boolean; hideHrdConnections?: boolean },
): boolean {
  if (connection.show_as_button === false) return false;
  if (
    options.hideHrdConnections !== false &&
    connection.options?.domain_aliases?.length &&
    connection.show_as_button !== true
  ) {
    return false;
  }
  if (
    options.embeddedBrowser &&
    BUILTIN_STRATEGIES[connection.strategy]?.disableEmbeddedBrowsers
  ) {
    return false;
  }
  return true;
}

/** The connections to render as social / enterprise buttons, in client order. */
export function getButtonConnections(
  connections: Connection[],
  userAgent: string | undefined,
  options: {
    /**
     * Hide HRD connections (default). Only screens whose submit routes the
     * identifier by email domain may hide them; elsewhere the button is the
     * connection's only way in.
     */
    hideHrdConnections?: boolean;
  } = {},
): Connection[] {
  const embeddedBrowser = detectEmbeddedBrowser(userAgent) !== undefined;
  return connections.filter(
    (c) =>
      !isFormConnection(c) &&
      isShownAsButton(c, {
        embeddedBrowser,
        hideHrdConnections: options.hideHrdConnections,
      }),
  );
}
