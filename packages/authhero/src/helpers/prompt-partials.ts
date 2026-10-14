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

// Partials are rendered inside the login form, so only content, layout and
// form-field elements are allowed. Embedded content (iframe/object/embed),
// navigation/document-level elements (base/meta/link/form), styles and
// SVG/MathML (including animation elements) are intentionally excluded, as are
// form-override attributes (formaction etc.) so credentials can't be posted to
// an external host.
const ALLOWED_TAGS = [
  "a",
  "abbr",
  "b",
  "blockquote",
  "br",
  "button",
  "caption",
  "cite",
  "code",
  "datalist",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "fieldset",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "input",
  "ins",
  "kbd",
  "label",
  "legend",
  "li",
  "mark",
  "ol",
  "optgroup",
  "option",
  "p",
  "pre",
  "q",
  "s",
  "section",
  "select",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "textarea",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "u",
  "ul",
];
const ALLOWED_TAG_SET = new Set(ALLOWED_TAGS);

const GLOBAL_ATTRIBUTES = [
  "class",
  "id",
  "title",
  "lang",
  "dir",
  "role",
  "hidden",
  "tabindex",
];

const ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  "*": [...GLOBAL_ATTRIBUTES, "aria-*", "data-*"],
  a: ["href", "target", "rel", "name"],
  blockquote: ["cite"],
  q: ["cite"],
  del: ["cite", "datetime"],
  ins: ["cite", "datetime"],
  time: ["datetime"],
  img: ["src", "alt", "width", "height", "loading"],
  label: ["for"],
  button: ["type", "name", "value", "disabled"],
  fieldset: ["name", "disabled"],
  input: [
    "name",
    "type",
    "value",
    "placeholder",
    "required",
    "checked",
    "disabled",
    "readonly",
    "autocomplete",
    "inputmode",
    "pattern",
    "min",
    "max",
    "minlength",
    "maxlength",
    "step",
    "size",
    "multiple",
    "list",
  ],
  select: ["name", "required", "disabled", "multiple", "size", "autocomplete"],
  optgroup: ["label", "disabled"],
  option: ["value", "label", "selected", "disabled"],
  textarea: [
    "name",
    "rows",
    "cols",
    "placeholder",
    "required",
    "disabled",
    "readonly",
    "minlength",
    "maxlength",
    "autocomplete",
  ],
  ol: ["start", "type", "reversed"],
  li: ["value"],
  td: ["colspan", "rowspan", "headers"],
  th: ["colspan", "rowspan", "headers", "scope"],
  details: ["open"],
};

const ALLOWED_URL_SCHEMES = ["http", "https", "mailto", "tel"];

// Every attribute that can carry a URL. Most are not in the allowlist and are
// dropped anyway; listing them keeps scheme validation in place if the
// allowlist is ever extended.
const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "srcset",
  "srcdoc",
  "cite",
  "action",
  "formaction",
  "poster",
  "data",
  "xlink:href",
  "background",
  "from",
  "to",
  "values",
  "by",
]);

function isAllowedAttribute(tagName: string, name: string): boolean {
  if (/^on/i.test(name)) return false;
  if (/^(aria|data)-[a-z0-9_.:-]+$/.test(name)) return true;
  return (
    GLOBAL_ATTRIBUTES.includes(name) ||
    (ALLOWED_ATTRIBUTES[tagName]?.includes(name) ?? false)
  );
}

function isSafeUrl(value: string): boolean {
  const normalized = value.replace(/[\u0000- \u007f]/g, "").toLowerCase();
  // Browsers treat `//host`, `\\host` and `/\host` as protocol-relative.
  if (/^[\\/]{2}/.test(normalized)) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(normalized)?.[1];
  return scheme === undefined || ALLOWED_URL_SCHEMES.includes(scheme);
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
  const sanitized = sanitizeHtml(withoutScripts, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ALLOWED_URL_SCHEMES,
    allowedSchemesAppliedToAttributes: [...URL_ATTRIBUTES],
    allowProtocolRelative: false,
    transformTags: {
      "*": (tagName, attribs) => {
        // sanitize-html drops disallowed tags/attributes silently; track it
        // here so safe input can still be returned byte-for-byte below.
        if (!ALLOWED_TAG_SET.has(tagName.toLowerCase())) {
          removedUnsafeMarkup = true;
        }

        const safeAttributes: Record<string, string> = {};

        for (const [name, value] of Object.entries(attribs)) {
          const lowerName = name.toLowerCase();
          if (
            !isAllowedAttribute(tagName.toLowerCase(), lowerName) ||
            (URL_ATTRIBUTES.has(lowerName) && !isSafeUrl(value))
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
