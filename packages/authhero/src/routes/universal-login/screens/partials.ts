/**
 * Shared helpers for prompt partials (tenant-authored HTML injected into the
 * u2 widget form): parsing the ulp-* controls out of the stored HTML, enforcing
 * their constraints server-side, mapping them onto the user, and restoring
 * submitted state / errors when a screen is re-rendered.
 */

import type { User, UiScreen } from "@authhero/adapter-interfaces";
import type { ScreenContext, ScreenDefinition, ScreenResult } from "./types";

export type PrefillValue = string | string[];

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const ATTR_VALUE = `(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`;

function getAttr(tag: string, attr: string): string | undefined {
  const match = tag.match(new RegExp(`\\s${attr}\\s*=\\s*${ATTR_VALUE}`, "i"));
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function removeAttr(tag: string, attr: string): string {
  return tag.replace(
    new RegExp(
      `\\s${attr}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?(?=[\\s/>])`,
      "gi",
    ),
    "",
  );
}

function addAttrs(tag: string, attrs: string): string {
  const closing = tag.match(/\s*\/?>$/)?.[0] ?? ">";
  const prefix = tag.slice(0, -closing.length);
  return `${prefix}${attrs}${closing.includes("/") ? " />" : ">"}`;
}

export interface PartialField {
  name: string;
  type: string;
  required: boolean;
  maxlength?: number;
  pattern?: string;
  map?: string;
  label: string;
}

const MAP_TARGETS = [
  "given_name",
  "family_name",
  "name",
  "nickname",
  "picture",
] as const;

/** Only allowlisted targets may be written by `data-authhero-map`. */
export function isValidAuthheroMapTarget(target: string): boolean {
  if ((MAP_TARGETS as readonly string[]).includes(target)) return true;
  const match = target.match(/^user_metadata\.([A-Za-z0-9_-]+)$/);
  return !!match && match[1] !== "__proto__";
}

function hasBooleanAttr(tag: string, attr: string): boolean {
  return new RegExp(`\\s${attr}(?=[\\s/>=])`, "i").test(tag);
}

/** Parse the ulp-* controls out of stored (trusted) prompt-partial HTML. */
export function parsePartialFields(htmls: string[]): PartialField[] {
  const fields: PartialField[] = [];
  for (const html of htmls) {
    const tags = html.match(
      /<(?:input|textarea|select)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi,
    );
    for (const tag of tags ?? []) {
      const name = getAttr(tag, "name");
      if (!name?.startsWith("ulp-")) continue;
      const kind = (tag.match(/^<(\w+)/)?.[1] ?? "").toLowerCase();
      const type =
        kind === "input"
          ? (getAttr(tag, "type") ?? "text").toLowerCase()
          : kind;
      if (
        ["submit", "button", "image", "reset", "file", "hidden"].includes(type)
      )
        continue;
      const maxlength = Number.parseInt(getAttr(tag, "maxlength") ?? "", 10);
      const map = getAttr(tag, "data-authhero-map");
      fields.push({
        name,
        type,
        required: hasBooleanAttr(tag, "required"),
        maxlength: Number.isFinite(maxlength) ? maxlength : undefined,
        pattern: getAttr(tag, "pattern"),
        map: map && isValidAuthheroMapTarget(map) ? map : undefined,
        label:
          getAttr(tag, "aria-label") ?? getAttr(tag, "placeholder") ?? name,
      });
    }
  }
  return fields;
}

function submittedValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v) => typeof v === "string");
  return [];
}

/**
 * Enforce required / maxlength / pattern from the stored partial. Returns the
 * first failing field's message, or undefined when everything passes.
 */
export function validatePartialFields(
  fields: PartialField[],
  data: Record<string, unknown>,
): { name: string; message: string } | undefined {
  const seen = new Set<string>();
  for (const field of fields) {
    const values = submittedValues(data[field.name]);
    const nonEmpty = values.filter((v) => v.trim() !== "");
    // Checkbox/radio groups share a name: required means any member checked.
    const groupRequired = fields.some(
      (f) => f.name === field.name && f.required,
    );
    if (seen.has(field.name)) continue;
    seen.add(field.name);
    if (groupRequired && nonEmpty.length === 0) {
      return { name: field.name, message: `${field.label} is required` };
    }
    for (const value of values) {
      if (value === "") continue;
      if (field.maxlength !== undefined && value.length > field.maxlength) {
        return {
          name: field.name,
          message: `${field.label} must be at most ${field.maxlength} characters`,
        };
      }
      if (field.pattern) {
        try {
          if (!new RegExp(`^(?:${field.pattern})$`, "u").test(value)) {
            return {
              name: field.name,
              message: `${field.label} is not in the expected format`,
            };
          }
        } catch {
          // Invalid pattern: browsers ignore it, so do we.
        }
      }
    }
  }
  return undefined;
}

/** Build the user fields set by `data-authhero-map` from submitted data. */
export function applyPartialMappings(
  fields: PartialField[],
  data: Record<string, unknown>,
): Partial<
  Pick<
    User,
    | "given_name"
    | "family_name"
    | "name"
    | "nickname"
    | "picture"
    | "user_metadata"
  >
> {
  const result: Record<string, unknown> = {};
  const metadata: Record<string, string> = {};
  for (const field of fields) {
    if (!field.map) continue;
    const value = submittedValues(data[field.name])[0]?.trim();
    if (!value) continue;
    if (field.map.startsWith("user_metadata.")) {
      metadata[field.map.slice("user_metadata.".length)] = value;
    } else {
      result[field.map] = value;
    }
  }
  if (Object.keys(metadata).length > 0) result.user_metadata = metadata;
  return result;
}

const ERROR_INFO_CLASS = /\bulp-error-info\b/;

function addClass(tag: string, cls: string): string {
  const existing = getAttr(tag, "class");
  if (existing === undefined) return addAttrs(tag, ` class="${cls}"`);
  return addAttrs(
    removeAttr(tag, "class"),
    ` class="${escapeHtmlAttribute(`${existing} ${cls}`)}"`,
  );
}

/**
 * Auth0-style field errors for prompt partials: the `ulp-field` wrapper around
 * a failing input gets `ulp-error`, and its `ulp-error-info` element (added if
 * missing) carries the message. Returns the rewritten HTML and the names of the
 * fields whose error was placed.
 */
export function applyPartialErrors(
  html: string,
  errors: Record<string, string>,
): { html: string; placed: Set<string> } {
  const placed = new Set<string>();
  let out = "";
  let cursor = 0;
  const open = /<div\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  let match: RegExpExecArray | null;
  while ((match = open.exec(html))) {
    if (match.index < cursor) continue;
    const tag = match[0];
    if (!/\bulp-field\b/.test(getAttr(tag, "class") ?? "")) continue;

    // Find the matching </div> by tracking nesting depth.
    const divs = /<(\/?)div\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
    divs.lastIndex = match.index + tag.length;
    let depth = 1;
    let closeAt = -1;
    let d: RegExpExecArray | null;
    while ((d = divs.exec(html))) {
      depth += d[1] ? -1 : 1;
      if (depth === 0) {
        closeAt = d.index;
        break;
      }
    }
    if (closeAt < 0) continue;

    const inner = html.slice(match.index + tag.length, closeAt);
    const name = (
      inner.match(
        /<(?:input|textarea|select)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi,
      ) ?? []
    )
      .map((t) => getAttr(t, "name"))
      .find((n) => n !== undefined && errors[n] !== undefined);
    if (name === undefined) continue;

    const message = escapeHtmlText(errors[name] ?? "");
    const infoRe =
      /(<(\w+)\b[^>]*\bulp-error-info\b[^>]*>)[\s\S]*?(<\/\2\s*>)/i;
    const newInner =
      ERROR_INFO_CLASS.test(inner) && infoRe.test(inner)
        ? inner.replace(infoRe, `$1${message}$3`)
        : `${inner}<div class="ulp-error-info">${message}</div>`;

    out +=
      html.slice(cursor, match.index) + addClass(tag, "ulp-error") + newInner;
    cursor = closeAt;
    placed.add(name);
    open.lastIndex = closeAt;
  }
  return { html: out + html.slice(cursor), placed };
}

function prefillValues(value: PrefillValue): string[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Restore submitted ulp-* control state in stored prompt-partial HTML: `value`
 * for text-like inputs, `checked` for checkboxes/radios, and the content or
 * selected options for textarea/select. Passwords and unrelated fields never
 * enter the prefill object.
 */
export function prefillPromptPartial(
  html: string,
  prefill?: Record<string, PrefillValue | undefined>,
): string {
  if (!prefill) return html;

  const lookup = (tag: string) => {
    const name = getAttr(tag, "name");
    return name?.startsWith("ulp-") ? prefill[name] : undefined;
  };

  const withInputs = html.replace(
    /<input\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi,
    (input) => {
      const submitted = lookup(input);
      if (submitted === undefined) return input;

      const type = (getAttr(input, "type") ?? "text").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        // Compare against the control's own value ("on" is the HTML default).
        const own = getAttr(input, "value") ?? "on";
        const base = removeAttr(input, "checked");
        return prefillValues(submitted).includes(own)
          ? addAttrs(base, " checked")
          : base;
      }
      if (
        ["file", "submit", "button", "image", "reset", "password"].includes(
          type,
        )
      ) {
        return input;
      }
      if (Array.isArray(submitted)) return input;

      return addAttrs(
        removeAttr(input, "value"),
        ` value="${escapeHtmlAttribute(submitted)}"`,
      );
    },
  );

  const withTextareas = withInputs.replace(
    /(<textarea\b(?:[^>"']|"[^"]*"|'[^']*')*>)[\s\S]*?(<\/textarea\s*>)/gi,
    (match, open: string, close: string) => {
      const submitted = lookup(open);
      if (submitted === undefined || Array.isArray(submitted)) return match;
      return `${open}${escapeHtmlText(submitted)}${close}`;
    },
  );

  return withTextareas.replace(
    /(<select\b(?:[^>"']|"[^"]*"|'[^']*')*>)([\s\S]*?)(<\/select\s*>)/gi,
    (match, open: string, body: string, close: string) => {
      const submitted = lookup(open);
      if (submitted === undefined) return match;
      const selected = prefillValues(submitted);
      const options = body.replace(
        /<option\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi,
        (option) => {
          const base = removeAttr(option, "selected");
          // An option without a value attribute submits its text, which we
          // can't see from the opening tag alone; leave it unselected.
          const own = getAttr(option, "value");
          return own !== undefined && selected.includes(own)
            ? addAttrs(base, " selected")
            : base;
        },
      );
      return `${open}${options}${close}`;
    },
  );
}

/** A stored partial set: Auth0 keys partials by prompt, then screen. */
export interface PartialSource {
  prompt: string;
  screen: string;
}

async function getStoredPartialHtmls(
  context: ScreenContext,
  sources: PartialSource[],
): Promise<Record<string, string>[]> {
  const stored = await Promise.all(
    sources.map(async ({ prompt, screen }) => {
      const partials = await context.ctx.env.data.promptPartials?.get(
        context.tenant.id,
        prompt,
      );
      return partials?.[screen];
    }),
  );
  return stored.filter((p): p is Record<string, string> => !!p);
}

/** Parse the ulp-* controls out of every stored partial for these sources. */
export async function getPartialFields(
  context: ScreenContext,
  sources: PartialSource[],
): Promise<PartialField[]> {
  const stored = await getStoredPartialHtmls(context, sources);
  return parsePartialFields(stored.flatMap((p) => Object.values(p)));
}

/** Only ulp-* values are ever restored into partial controls. */
export function getUlpPrefill(
  body?: Record<string, unknown>,
): Record<string, PrefillValue> {
  const fields: Record<string, PrefillValue> = {};
  for (const [key, value] of Object.entries(body ?? {})) {
    if (!key.startsWith("ulp-")) continue;
    if (typeof value === "string") {
      fields[key] = value;
    } else if (
      Array.isArray(value) &&
      value.every((v) => typeof v === "string")
    ) {
      fields[key] = value as string[];
    }
  }
  return fields;
}

/**
 * Load the stored partials for a screen, restore submitted state and place
 * field errors. Several sources are merged per insertion point in the order
 * given. Errors without an `ulp-field` wrapper come back as screen messages.
 */
export async function loadScreenPartials(
  context: ScreenContext,
  sources: PartialSource[],
  state: Pick<ScreenContext, "prefill" | "errors"> = context,
): Promise<{
  partials: UiScreen["partials"];
  messages: { text: string; type: "error" }[];
}> {
  const stored = await getStoredPartialHtmls(context, sources);
  const errors = Object.fromEntries(
    Object.entries(state.errors ?? {}).filter(([key]) =>
      key.startsWith("ulp-"),
    ),
  );
  if (stored.length === 0) {
    return {
      partials: undefined,
      messages: Object.values(errors).map((text) => ({
        text,
        type: "error" as const,
      })),
    };
  }

  const merged: Record<string, string> = {};
  for (const insertionPoints of stored) {
    for (const [insertionPoint, html] of Object.entries(insertionPoints)) {
      merged[insertionPoint] = (merged[insertionPoint] ?? "") + html;
    }
  }

  const placedErrors = new Set<string>();
  const partials = Object.fromEntries(
    Object.entries(merged).map(([insertionPoint, html]) => {
      const { html: withErrors, placed } = applyPartialErrors(
        prefillPromptPartial(html, state.prefill),
        errors,
      );
      placed.forEach((name) => placedErrors.add(name));
      return [insertionPoint, withErrors];
    }),
  );
  const messages = Object.entries(errors)
    .filter(([name]) => !placedErrors.has(name))
    .map(([, text]) => ({ text, type: "error" as const }));

  return { partials: partials as UiScreen["partials"], messages };
}

/**
 * Which stored partials each login screen shows, keyed by UiScreen name.
 * Handlers build the next step by calling the next screen's factory directly,
 * so a wrapper also has to attach partials to screens it did not wrap.
 */
export const LOGIN_SCREEN_PARTIAL_SOURCES: Record<string, PartialSource[]> = {
  identifier: [{ prompt: "login-id", screen: "login-id" }],
  "enter-password": [{ prompt: "login-password", screen: "login-password" }],
  login: [{ prompt: "login", screen: "login" }],
};

async function withScreenPartials(
  result: ScreenResult,
  context: ScreenContext,
  sources: PartialSource[],
  state: Pick<ScreenContext, "prefill" | "errors">,
): Promise<ScreenResult> {
  const { partials, messages } = await loadScreenPartials(
    context,
    sources,
    state,
  );
  if (!partials && messages.length === 0) return result;
  return {
    ...result,
    screen: {
      ...result.screen,
      ...(partials ? { partials } : {}),
      ...(messages.length > 0
        ? { messages: [...(result.screen.messages ?? []), ...messages] }
        : {}),
    },
  };
}

/**
 * Add stored prompt partials to a login screen: they are rendered on GET and on
 * every re-render of this screen from POST, and the submitted ulp-* fields are
 * validated against the stored HTML and exposed to hooks as
 * `event.request.body` (`login_body`). Unlike signup there is no user mapping.
 */
export function withPartials(
  definition: ScreenDefinition,
  sources: PartialSource[],
): ScreenDefinition {
  const { get, post } = definition.handler;
  return {
    ...definition,
    handler: {
      get: async (context) =>
        withScreenPartials(await get(context), context, sources, context),
      post: post
        ? async (context, data) => {
            const prefill = getUlpPrefill(data);
            const fields = await getPartialFields(context, sources);
            const failure = validatePartialFields(fields, data);
            if (failure) {
              const state = {
                prefill: {
                  ...prefill,
                  ...(typeof data.username === "string"
                    ? { username: data.username }
                    : {}),
                },
                errors: { [failure.name]: failure.message },
              };
              const screen = await withScreenPartials(
                await get({ ...context, ...state }),
                context,
                sources,
                state,
              );
              return { error: failure.message, screen };
            }

            context.ctx.set("login_body", prefill);
            const result = await post(context, data);
            // Re-renders of this screen keep the submitted values; a successful
            // step returns the next screen, which gets its own partials.
            if ("screen" in result) {
              const name = result.screen.screen.name ?? "";
              const nextSources = LOGIN_SCREEN_PARTIAL_SOURCES[name];
              if (nextSources) {
                return {
                  ...result,
                  screen: await withScreenPartials(
                    result.screen,
                    context,
                    nextSources,
                    name === definition.id ? { prefill } : {},
                  ),
                };
              }
            }
            return result;
          }
        : undefined,
    },
  };
}
