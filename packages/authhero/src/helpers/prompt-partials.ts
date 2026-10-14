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
  // Auth0's own names for the passwordless prompts; `login-passwordless` is
  // kept as an alias.
  "login-passwordless-sms-otp",
  "login-passwordless-email-code",
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

// Partials are authored by tenant admins and, like Auth0's, may contain HTML,
// CSS (`style`) and JavaScript (`script`) plus Liquid, so an exported Auth0
// partial can be used as is. What stays blocked is markup that escapes the
// login page or hijacks the form: embedded content (iframe/object/embed),
// document-level/navigation elements (base/meta/link/form), SVG/MathML,
// unsafe URL schemes and form-override attributes
// (formaction etc.) so credentials can't be posted to an external host.
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
  "script",
  "section",
  "select",
  "small",
  "span",
  "strong",
  "style",
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

const GLOBAL_ATTRIBUTES = [
  "class",
  "id",
  "title",
  "lang",
  "dir",
  "role",
  "hidden",
  "tabindex",
  // `style` is fine now that `<style>` is allowed.
  "style",
  "spellcheck",
  "autofocus",
];

const ALLOWED_ATTRIBUTES: Record<string, string[]> = {
  "*": [...GLOBAL_ATTRIBUTES, "aria-*", "data-*", "on*"],
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
    "type",
    "wrap",
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
  script: [
    "src",
    "type",
    "async",
    "defer",
    "crossorigin",
    "integrity",
    "nomodule",
  ],
  style: ["media", "type"],
};

const ALLOWED_TAG_SET = new Set(ALLOWED_TAGS);

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
  // Inline handlers are allowed like `script`: Auth0 partials use both.
  if (/^on[a-z]+$/.test(name)) return true;
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

function sanitizeShielded(html: string, location: string): string {
  if (html.length > MAX_PROMPT_PARTIAL_LENGTH) {
    throw new HTTPException(400, {
      message: `${location} exceeds the ${MAX_PROMPT_PARTIAL_LENGTH}-character limit`,
    });
  }

  let invalidMappingTarget: string | undefined;
  const removed = new Set<string>();
  let rewroteRel = false;
  const sanitized = sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ALLOWED_URL_SCHEMES,
    allowedSchemesAppliedToAttributes: [...URL_ATTRIBUTES],
    allowProtocolRelative: false,
    allowVulnerableTags: true,
    nonTextTags: ["script", "style"],
    transformTags: {
      "*": (tagName, attribs) => {
        if (!ALLOWED_TAG_SET.has(tagName.toLowerCase())) {
          removed.add(`<${tagName.toLowerCase()}>`);
        }

        const safeAttributes: Record<string, string> = {};

        for (const [name, value] of Object.entries(attribs)) {
          const lowerName = name.toLowerCase();
          if (
            !isAllowedAttribute(tagName.toLowerCase(), lowerName) ||
            (URL_ATTRIBUTES.has(lowerName) && !isSafeUrl(value))
          ) {
            removed.add(`${lowerName} on <${tagName.toLowerCase()}>`);
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

        if (
          tagName.toLowerCase() === "a" &&
          safeAttributes.target?.toLowerCase() === "_blank"
        ) {
          rewroteRel ||= safeAttributes.rel !== "noopener noreferrer";
          safeAttributes.rel = "noopener noreferrer";
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

  // Rejecting instead of silently rewriting keeps what is read back identical
  // to what was sent, which Terraform and Deploy CLI depend on.
  if (removed.size > 0) {
    throw new HTTPException(400, {
      message: `Disallowed markup at ${location}: ${[...removed].join(", ")}`,
    });
  }

  // sanitize-html serializes void elements as XHTML (`<input />`). To keep
  // Terraform/Deploy CLI round-trips stable, return the original string when
  // filtering removed nothing: a pass with the same parser but no filtering
  // normalizes serialization only, so equal output means nothing was dropped.
  // The unfiltered output must also match the input apart from XHTML void
  // tags, otherwise the parser read the input differently than it was written
  // (malformed tags, quoting, entities) and a browser might too.
  // Comments/CDATA/processing instructions are always dropped by the parser and
  // would be invisible to that comparison, so they never take the shortcut.
  if (rewroteRel || /<!|<\?/.test(html)) return sanitized;
  const unfiltered = sanitizeHtml(html, {
    allowedTags: false,
    allowedAttributes: false,
    allowVulnerableTags: true,
    allowProtocolRelative: true,
    allowedSchemes: false,
    allowedSchemesAppliedToAttributes: [],
  });
  // A bare `>` or a `<` that cannot start a tag is plain text to browsers, so
  // Liquid comparisons like `{% if a < b %}` are left as written.
  const serialized = unfiltered
    .replace(/ \/>/g, ">")
    .replace(/&gt;/g, ">")
    .replace(/&lt;(?![a-zA-Z/!?])/g, "<");
  // sanitize-html also drops the `=""` of empty attributes (`value=""`), which
  // changes what a browser does with e.g. `<option value="">`, so the original
  // is kept when that is the only difference.
  const withoutEmptyValues = (value: string) =>
    value.replace(/ [\w:.-]+=""/g, "");
  return unfiltered === sanitized &&
    withoutEmptyValues(serialized) === withoutEmptyValues(html)
    ? html
    : sanitized;
}

const LIQUID_TOKEN = /\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/y;

// Liquid is valid in text and attribute values as is, but HTML parsers read a
// token between attributes (`<option {% if x %}selected{% endif %}>`) as
// attribute names. Swap those for placeholder attributes while sanitizing.
function shieldLiquidInTags(html: string): {
  shielded: string;
  tokens: { token: string; spaced: boolean }[];
} {
  const tokens: { token: string; spaced: boolean }[] = [];
  let out = "";
  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch !== "<" || !/[a-zA-Z]/.test(html[i + 1] ?? "")) {
      out += ch;
      i++;
      continue;
    }
    // Inside a start tag: copy until the closing `>`, treating quoted values
    // and Liquid tokens (which may contain `>` or quotes) as opaque.
    let quote = "";
    while (i < html.length) {
      LIQUID_TOKEN.lastIndex = i;
      const token = html[i] === "{" ? LIQUID_TOKEN.exec(html)?.[0] : undefined;
      if (token) {
        if (quote) {
          // Tokens may hold quotes or `>`, which would end the value early.
          out += `__authhero_liquid_${tokens.length}__`;
          tokens.push({ token, spaced: false });
        } else {
          const spaced = /\s$/.test(out);
          out += `${spaced ? "" : " "}data-liquid-${tokens.length}`;
          tokens.push({ token, spaced });
        }
        i += token.length;
        continue;
      }
      const c = html[i];
      out += c;
      i++;
      if (quote) {
        if (c === quote) quote = "";
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        break;
      }
    }
  }
  return { shielded: out, tokens };
}

function sanitizePromptPartial(html: string, location: string): string {
  const { shielded, tokens } = shieldLiquidInTags(html);
  const result = sanitizeShielded(shielded, location);
  // Unchanged input is returned as written, Liquid included.
  if (result === shielded) return html;
  return result.replace(
    / data-liquid-(\d+)|__authhero_liquid_(\d+)__/g,
    (match, tagIndex, valueIndex) => {
      const entry = tokens[Number(tagIndex ?? valueIndex)];
      if (entry === undefined) return match;
      return tagIndex !== undefined && entry.spaced
        ? ` ${entry.token}`
        : entry.token;
    },
  );
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
