/**
 * Serialize / parse for the prompt partials field builder.
 *
 * The builder edits a list of fields and generates the partial HTML that the
 * widget renders into a prompt's insertion point. `parseFields` only returns
 * fields when the HTML round-trips exactly (`serializeFields(parse(html)) ===
 * html`), so imported or hand-written HTML is never silently rewritten: it
 * stays in HTML mode until the user chooses to edit it as fields.
 */

export const FIELD_TYPES = [
  "text",
  "email",
  "number",
  "checkbox",
  "select",
] as const;
export type BuilderFieldType = (typeof FIELD_TYPES)[number];

export type BuilderField = {
  label: string;
  /** Field name. The `ulp-` prefix is added on serialize if missing. */
  name: string;
  type: BuilderFieldType;
  required: boolean;
  placeholder?: string;
  maxLength?: number;
  /** Only used by `select` fields. */
  options?: string[];
  /** `data-authhero-map` target; empty/undefined means "don't save". */
  mapTo?: string;
};

export const PARTIAL_INSERTION_POINTS = [
  "form-content-start",
  "form-content-end",
  "form-footer-start",
  "form-footer-end",
  "secondary-actions-start",
  "secondary-actions-end",
] as const;
export type PartialInsertionPoint = (typeof PARTIAL_INSERTION_POINTS)[number];

/**
 * Prompts the widget renders partials for. The API accepts more, but only the
 * signup and login screens read stored partials today, so offering others
 * would save HTML that is never shown. Add prompts here as screens start
 * consuming them.
 */
export const PARTIAL_PROMPTS = [
  "signup",
  "login-id",
  "login-password",
  "login",
] as const;

export const FIXED_MAP_TARGETS = [
  "given_name",
  "family_name",
  "name",
  "nickname",
] as const;

const USER_METADATA_PREFIX = "user_metadata.";
const USER_METADATA_KEY = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** Only a single-level `user_metadata.<key>` is accepted by the signup runtime. */
export function isValidMapTarget(target: string): boolean {
  if ((FIXED_MAP_TARGETS as readonly string[]).includes(target)) return true;
  if (!target.startsWith(USER_METADATA_PREFIX)) return false;
  const key = target.slice(USER_METADATA_PREFIX.length);
  return USER_METADATA_KEY.test(key) && !FORBIDDEN_KEYS.has(key);
}

/** Lower-cases, slugifies and prefixes with `ulp-`. Idempotent. */
export function ensureUlpName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const bare = slug.replace(/^ulp-+/, "");
  return `ulp-${bare}`;
}

/** Suggests a field name from a label, e.g. "First name" -> "ulp-first-name". */
export function nameFromLabel(label: string): string {
  return ensureUlpName(label);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const REQUIRED_MARK = '<span class="required" aria-hidden="true">*</span>';

/**
 * Markup follows the widget's own partial styling (`.prompt-partial` CSS):
 * - text/email/number without a placeholder: the input comes first, then the
 *   label, so the label floats inside the field like built-in fields. The
 *   input gets `placeholder=" "` for that to work.
 * - with a placeholder: label above the input (a floating label would overlap
 *   the placeholder text).
 * - select: control first, label floats above it.
 * - checkbox: the input is wrapped in its label, so the floating-label rule
 *   (`input + label`) does not apply.
 * Required fields get the widget's red asterisk via `.required`.
 */
function serializeField(field: BuilderField): string {
  const name = escapeHtml(ensureUlpName(field.name));
  const attrs = [`id="${name}"`, `name="${name}"`];
  if (field.required) attrs.push("required");
  if (field.mapTo && isValidMapTarget(field.mapTo)) {
    attrs.push(`data-authhero-map="${escapeHtml(field.mapTo)}"`);
  }
  const labelText = `${escapeHtml(field.label)}${field.required ? REQUIRED_MARK : ""}`;
  const label = `<label for="${name}">${labelText}</label>`;

  if (field.type === "select") {
    const options = (field.options ?? [])
      .filter((o) => o.trim())
      .map((o) => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`)
      .join("");
    return `<div class="ulp-field"><select ${attrs.join(" ")}>${options}</select>${label}</div>`;
  }

  if (field.type === "checkbox") {
    return `<div class="ulp-field"><label for="${name}"><input type="checkbox" ${attrs.join(" ")}> ${labelText}</label></div>`;
  }

  const hasPlaceholder = !!field.placeholder;
  attrs.push(`placeholder="${escapeHtml(field.placeholder || " ")}"`);
  if (field.maxLength !== undefined && field.maxLength > 0) {
    attrs.push(`maxlength="${Math.floor(field.maxLength)}"`);
  }
  const input = `<input type="${field.type}" ${attrs.join(" ")}>`;
  return `<div class="ulp-field">${hasPlaceholder ? label + input : input + label}</div>`;
}

export function serializeFields(fields: BuilderField[]): string {
  return fields.map(serializeField).join("\n");
}

function labelText(label: Element): string {
  const clone = label.cloneNode(true) as Element;
  clone.querySelectorAll("input, span.required").forEach((n) => n.remove());
  return (clone.textContent ?? "").trim();
}

function parseField(el: Element): BuilderField | null {
  if (el.tagName !== "DIV" || el.getAttribute("class") !== "ulp-field") {
    return null;
  }
  const control = el.querySelector("input, select, textarea");
  const label = el.querySelector("label");
  if (!control || !label) return null;

  const name = control.getAttribute("name") ?? "";
  if (!name.startsWith("ulp-")) return null;

  let type: BuilderFieldType;
  if (control.tagName === "SELECT") {
    type = "select";
  } else if (control.tagName === "INPUT") {
    const t = control.getAttribute("type") ?? "text";
    if (!(FIELD_TYPES as readonly string[]).includes(t) || t === "select") {
      return null;
    }
    type = t as BuilderFieldType;
  } else {
    return null;
  }

  const field: BuilderField = {
    label: labelText(label),
    name,
    type,
    required: control.hasAttribute("required"),
  };
  const mapTo = control.getAttribute("data-authhero-map");
  if (mapTo) field.mapTo = mapTo;
  const placeholder = control.getAttribute("placeholder");
  // `placeholder=" "` is the floating-label marker, not a user placeholder.
  if (placeholder && placeholder !== " ") field.placeholder = placeholder;
  const maxLength = control.getAttribute("maxlength");
  if (maxLength) {
    const n = Number(maxLength);
    if (!Number.isInteger(n) || n <= 0) return null;
    field.maxLength = n;
  }
  if (type === "select") {
    field.options = Array.from(control.querySelectorAll("option")).map(
      (o) => o.textContent ?? "",
    );
  }
  return field;
}

/**
 * Parses partial HTML into builder fields. Returns `null` unless the HTML is
 * exactly what `serializeFields` would produce for the parsed fields.
 * Empty HTML parses to an empty field list.
 */
export function parseFields(html: string): BuilderField[] | null {
  const trimmed = html.trim();
  if (!trimmed) return [];
  if (typeof DOMParser === "undefined") return null;

  const doc = new DOMParser().parseFromString(
    `<body>${trimmed}</body>`,
    "text/html",
  );
  const fields: BuilderField[] = [];
  for (const node of Array.from(doc.body.childNodes)) {
    if (node.nodeType === 3 && !(node.textContent ?? "").trim()) continue;
    if (node.nodeType !== 1) return null;
    const field = parseField(node as Element);
    if (!field) return null;
    fields.push(field);
  }
  return serializeFields(fields) === trimmed ? fields : null;
}

/** The API stores `{ [screen]: { [insertionPoint]: html } }`. */
export type PromptPartials = Record<
  string,
  Partial<Record<PartialInsertionPoint, string>>
>;

/** Matches the `<screen>.<insertion-point>` location in API validation errors. */
export function errorLocation(message: string): PartialInsertionPoint | null {
  for (const point of PARTIAL_INSERTION_POINTS) {
    // Longest-first is unnecessary: no point name is a suffix of another.
    if (message.includes(`.${point}`)) return point;
  }
  return null;
}

export type FieldPosition = { point: PartialInsertionPoint; index: number };

/**
 * Moves one field to a new position, within a list or between insertion
 * points. `to.index` is the insertion position in the target list *before* the
 * move (0..length), as shown by a drop indicator. Returns the changed lists
 * only, or `null` when nothing would change.
 */
export function moveField<T extends BuilderField>(
  lists: Partial<Record<PartialInsertionPoint, T[]>>,
  from: FieldPosition,
  to: FieldPosition,
): Partial<Record<PartialInsertionPoint, T[]>> | null {
  const source = lists[from.point];
  const target = lists[to.point];
  const field = source?.[from.index];
  if (!source || !target || !field) return null;

  if (from.point === to.point) {
    const insertAt = to.index > from.index ? to.index - 1 : to.index;
    if (insertAt === from.index) return null;
    const next = [...source];
    next.splice(from.index, 1);
    next.splice(insertAt, 0, field);
    return { [to.point]: next };
  }

  const nextSource = source.filter((_, i) => i !== from.index);
  const nextTarget = [...target];
  nextTarget.splice(Math.min(to.index, target.length), 0, field);
  return { [from.point]: nextSource, [to.point]: nextTarget };
}

export type FieldIssue = {
  message: string;
  /**
   * `always` issues are wrong however far along the user is (a clash with
   * another field, an invalid key). `attempt` issues are just unfinished
   * fields, so they are shown only once the user tries to save.
   */
  when: "always" | "attempt";
};

/**
 * Checks fields before saving. Returns the issues per field, in list order,
 * for every insertion point given. Names are compared across all lists since
 * a form submits them as one set (two fields with the same `ulp-` name would
 * overwrite each other).
 */
export function validateFields(
  lists: Partial<Record<PartialInsertionPoint, BuilderField[]>>,
): Partial<Record<PartialInsertionPoint, FieldIssue[][]>> {
  const counts = new Map<string, number>();
  for (const fields of Object.values(lists)) {
    for (const field of fields ?? []) {
      const name = ensureUlpName(field.name);
      if (name !== "ulp-") counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }

  const result: Partial<Record<PartialInsertionPoint, FieldIssue[][]>> = {};
  for (const [point, fields] of Object.entries(lists) as [
    PartialInsertionPoint,
    BuilderField[],
  ][]) {
    result[point] = fields.map((field) => {
      const issues: FieldIssue[] = [];
      const name = ensureUlpName(field.name);

      if (!field.label.trim()) {
        issues.push({ message: "Label is required", when: "attempt" });
      } else if (name === "ulp-") {
        issues.push({ message: "Name is required", when: "attempt" });
      }
      if ((counts.get(name) ?? 0) > 1) {
        issues.push({
          message: `The name "${name}" is used by another field. Names must be unique.`,
          when: "always",
        });
      }

      if (field.mapTo) {
        if (field.mapTo === `${USER_METADATA_PREFIX}`) {
          issues.push({
            message: "Enter a user_metadata key",
            when: "attempt",
          });
        } else if (!isValidMapTarget(field.mapTo)) {
          issues.push({
            message:
              "The user_metadata key can only contain letters, numbers, - and _",
            when: "always",
          });
        }
      }

      if (
        field.type === "select" &&
        !(field.options ?? []).some((o) => o.trim())
      ) {
        issues.push({ message: "Add at least one option", when: "attempt" });
      }
      return issues;
    });
  }
  return result;
}
