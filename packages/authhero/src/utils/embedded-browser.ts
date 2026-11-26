import { DefaultUserAgentDetector } from "../client/user-agent-detector";

/** Detects in-app browsers from the request's User-Agent. */
export function detectEmbeddedBrowser(
  userAgent: string | undefined,
): { name?: string } | undefined {
  const info = new DefaultUserAgentDetector().parse(userAgent || "");
  // The shared detector flags Samsung Internet, but it is a standalone browser
  // with normal session handling. Only apps hosting a WebView should warn.
  if (!info.isEmbedded || info.browser?.name === "Samsung Internet") {
    return undefined;
  }
  return { name: info.browser?.name };
}
