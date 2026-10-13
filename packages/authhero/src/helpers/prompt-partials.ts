import sanitizeHtml from "sanitize-html";
import type { PromptPartials } from "@authhero/adapter-interfaces";
import { HTTPException } from "hono/http-exception";

export const promptPartialPrompts = [
  "signup",
  "signup-id",
  "signup-password",
  "login",
  "login-id",
  "login-password",
  "login-passwordless",
] as const;

// Keep individual fragments bounded without imposing a small aggregate limit on
// prompts that contain several screens/insertion points.
export const MAX_PROMPT_PARTIAL_LENGTH = 100_000;

const ROOT_MAPPING_TARGETS = new Set([
  "given_name",
  "family_name",
  "name",
  "nickname",
  "picture",
]);

export function isAllowedPromptPartialMappingTarget(target: string): boolean {
  return (
    ROOT_MAPPING_TARGETS.has(target) ||
    /^user_metadata\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(target)
  );
}

function sanitizePromptPartial(html: string, location: string): string {
  if (html.length > MAX_PROMPT_PARTIAL_LENGTH) {
    throw new HTTPException(400, {
      message: `${location} exceeds the ${MAX_PROMPT_PARTIAL_LENGTH}-character limit`,
    });
  }

  let invalidMappingTarget: string | undefined;
  let removedUnsafeMarkup = false;
  const withoutScripts = html.replace(
    /<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)|<script\b[^>]*\/?\s*>/gi,
    () => {
      removedUnsafeMarkup = true;
      return "";
    },
  );
  const urlAttributes = new Set([
    "href",
    "src",
    "cite",
    "action",
    "formaction",
    "poster",
  ]);
  const sanitized = sanitizeHtml(withoutScripts, {
    // Prompt partials intentionally support arbitrary HTML. Security-sensitive
    // content is removed below while otherwise preserving imported markup.
    allowedTags: false,
    allowedAttributes: false,
    allowVulnerableTags: true,
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedSchemesAppliedToAttributes: [...urlAttributes],
    allowProtocolRelative: false,
    transformTags: {
      "*": (tagName, attribs) => {
        const safeAttributes: Record<string, string> = {};

        for (const [name, value] of Object.entries(attribs)) {
          const lowerName = name.toLowerCase();
          if (/^on/i.test(name)) {
            removedUnsafeMarkup = true;
            continue;
          }

          if (
            urlAttributes.has(lowerName) &&
            /^\s*javascript\s*:/i.test(
              value.replace(/[\u0000-\u001f\u007f]/g, ""),
            )
          ) {
            removedUnsafeMarkup = true;
            continue;
          }

          if (
            lowerName === "data-authhero-map" &&
            !isAllowedPromptPartialMappingTarget(value)
          ) {
            invalidMappingTarget = value;
          }

          safeAttributes[name] = value;
        }

        return { tagName, attribs: safeAttributes };
      },
    },
  });

  if (invalidMappingTarget !== undefined) {
    throw new HTTPException(400, {
      message: `Invalid data-authhero-map target "${invalidMappingTarget}" at ${location}`,
    });
  }

  // sanitize-html serializes void elements as XHTML (`<input />`). Preserve
  // safe input byte-for-byte so Terraform/Deploy CLI round-trips are stable.
  return removedUnsafeMarkup ? sanitized : html;
}

export function sanitizePromptPartials(
  partials: PromptPartials,
): PromptPartials {
  return Object.fromEntries(
    Object.entries(partials).map(([screen, insertionPoints]) => [
      screen,
      Object.fromEntries(
        Object.entries(insertionPoints).map(([insertionPoint, html]) => [
          insertionPoint,
          sanitizePromptPartial(html, `${screen}.${insertionPoint}`),
        ]),
      ),
    ]),
  );
}
