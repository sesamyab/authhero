/**
 * Signup screen - for new user registration
 *
 * Corresponds to: /u/signup
 */

import type {
  UiScreen,
  FormNodeComponent,
  User,
  CustomText,
} from "@authhero/adapter-interfaces";
import {
  LogTypes,
  Strategy,
  StrategyType,
  isDatabaseConnectionStrategy,
} from "@authhero/adapter-interfaces";
import type { ScreenContext, ScreenResult, ScreenDefinition } from "./types";
import { getLoginPath } from "./types";
import { createTranslation } from "../../../i18n";
import {
  getUsernamePasswordUser,
  resolveUsernamePasswordProvider,
} from "../../../utils/username-password-provider";
import {
  getPasswordPolicy,
  validatePasswordPolicy,
  hashPassword,
  PasswordPolicyError,
  PASSWORD_ERROR_CODES,
} from "../../../helpers/password-policy";
import { userIdGenerate } from "../../../utils/user-id";
import { sendValidateEmailAddress } from "../../../emails";
import { AuthError } from "../../../types/AuthError";
import {
  emailVerificationRequiredScreen,
  getLoginEmailVerification,
} from "./email-verification";
import { loginWithPassword } from "../../../authentication-flows/password";
import { logMessage } from "../../../helpers/logging";
import { SignupValidationError } from "../../../errors/signup-validation-error";

type PrefillValue = string | string[];

export function getSignupPrefill(
  email: string | undefined,
  signupBody?: Record<string, unknown>,
): Record<string, PrefillValue> {
  const customFields: Record<string, PrefillValue> = {};
  for (const [key, value] of Object.entries(signupBody ?? {})) {
    if (!key.startsWith("ulp-")) continue;
    if (typeof value === "string") {
      customFields[key] = value;
    } else if (
      Array.isArray(value) &&
      value.every((v) => typeof v === "string")
    ) {
      customFields[key] = value as string[];
    }
  }

  return { ...(email ? { email } : {}), ...customFields };
}

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

async function getSignupPartialFields(
  context: ScreenContext,
): Promise<PartialField[]> {
  const stored = await context.ctx.env.data.promptPartials?.get(
    context.tenant.id,
    "signup",
  );
  return parsePartialFields(Object.values(stored?.signup ?? {}));
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

/**
 * Translate a validatePasswordPolicy failure into a user-facing message.
 * The PasswordPolicyError message itself is English-only.
 */
export function localizePasswordPolicyError(
  error: unknown,
  locale: string,
  customText?: CustomText,
): string {
  const { m } = createTranslation(
    "signup-password",
    "signup-password",
    locale,
    customText,
  );
  if (!(error instanceof PasswordPolicyError)) {
    return m["password-too-weak"]();
  }
  switch (error.code) {
    case PASSWORD_ERROR_CODES.TOO_SHORT:
      return m.passwordTooShort({
        minLength: String(error.params?.minLength ?? ""),
      });
    case PASSWORD_ERROR_CODES.MISSING_LOWERCASE:
      return m.passwordMissingLowercase();
    case PASSWORD_ERROR_CODES.MISSING_UPPERCASE:
      return m.passwordMissingUppercase();
    case PASSWORD_ERROR_CODES.MISSING_NUMBER:
      return m.passwordMissingNumber();
    case PASSWORD_ERROR_CODES.MISSING_SPECIAL:
      return m.passwordMissingSpecial();
    case PASSWORD_ERROR_CODES.REUSED:
      return m.passwordReused();
    case PASSWORD_ERROR_CODES.CONTAINS_PERSONAL_INFO:
      return m.passwordContainsPersonalInfo();
    case PASSWORD_ERROR_CODES.CONTAINS_FORBIDDEN_WORD:
      return m.passwordContainsForbiddenWord();
    default:
      return m["password-too-weak"]();
  }
}

/**
 * Create the signup screen
 */
export async function signupScreen(
  context: ScreenContext,
): Promise<ScreenResult> {
  const { branding, state, prefill, errors, customText, routePrefix } = context;

  // Initialize i18n with locale and custom text overrides
  const locale = context.language || "en";
  const { m } = createTranslation("signup", "signup", locale, customText);

  // Check if we have password signup available
  const hasPasswordSignup = context.connections.some((c) =>
    isDatabaseConnectionStrategy(c.strategy),
  );

  const components: FormNodeComponent[] = [];

  // Add form fields for password signup
  if (hasPasswordSignup) {
    let order = 1;

    components.push(
      // Email input
      {
        id: "email",
        type: "EMAIL",
        category: "FIELD",
        visible: true,
        label: m.emailPlaceholder(),
        config: {
          placeholder: m.emailPlaceholder(),
        },
        required: true,
        order: order++,
      },
      // Password input
      {
        id: "password",
        type: "PASSWORD",
        category: "FIELD",
        visible: true,
        label: m.passwordPlaceholder(),
        config: {
          placeholder: m.passwordPlaceholder(),
          show_toggle: true,
        },
        required: true,
        sensitive: true,
        order: order++,
      },
      // Confirm password input
      {
        id: "re_password",
        type: "PASSWORD",
        category: "FIELD",
        visible: true,
        label: m.confirmPasswordPlaceholder(),
        config: {
          placeholder: m.confirmPasswordPlaceholder(),
          show_toggle: true,
        },
        required: true,
        sensitive: true,
        order: order++,
      },
      // Submit button
      {
        id: "submit",
        type: "NEXT_BUTTON",
        category: "BLOCK",
        visible: true,
        config: {
          text: m.buttonText(),
        },
        order: order++,
      },
    );
  }

  // Apply prefill and validation messages generically to built-in fields.
  for (const component of components) {
    if (component.category !== "FIELD") continue;

    const value = prefill?.[component.id];
    if (typeof value === "string" && "config" in component) {
      const config = (component.config ?? {}) as Record<string, unknown>;
      config.default_value = value;
      component.config = config as typeof component.config;
    }

    const error = errors?.[component.id];
    if (error) {
      component.messages = [{ text: error, type: "error" }];
    }
  }

  const storedPartials = await context.ctx.env.data.promptPartials?.get(
    context.tenant.id,
    "signup",
  );
  const signupPartials = storedPartials?.signup;
  const partialErrors = Object.fromEntries(
    Object.entries(errors ?? {}).filter(([key]) => key.startsWith("ulp-")),
  );
  const placedErrors = new Set<string>();
  const partials = signupPartials
    ? Object.fromEntries(
        Object.entries(signupPartials).map(([insertionPoint, html]) => {
          const { html: withErrors, placed } = applyPartialErrors(
            prefillPromptPartial(html, prefill),
            partialErrors,
          );
          placed.forEach((name) => placedErrors.add(name));
          return [insertionPoint, withErrors];
        }),
      )
    : undefined;
  // Errors for fields without a ulp-field wrapper fall back to the screen.
  const unplacedErrors = Object.entries(partialErrors)
    .filter(([name]) => !placedErrors.has(name))
    .map(([, text]) => ({ text, type: "error" as const }));

  // Determine login link based on identifier_first setting
  const loginPath = await getLoginPath(context);

  const screen: UiScreen = {
    name: "signup",
    // Action points to HTML endpoint for no-JS fallback
    action: `${routePrefix}/signup?state=${encodeURIComponent(state)}`,
    method: "POST",
    title: m.title(),
    description: m.description(),
    components,
    partials,
    ...(unplacedErrors.length > 0 ? { messages: unplacedErrors } : {}),
    links: [
      {
        id: "login",
        text: m.loginActionText(),
        linkText: m.loginActionLinkText(),
        href: `${loginPath}?state=${encodeURIComponent(state)}`,
      },
    ],
  };

  return {
    screen,
    branding,
  };
}

/**
 * Screen definition for the signup screen
 */
export const signupScreenDefinition: ScreenDefinition = {
  id: "signup",
  name: "Sign Up",
  description: "New user registration screen",
  handler: {
    get: signupScreen,
    post: async (context, data) => {
      const { ctx, client, state } = context;
      const email = (data.email as string)?.toLowerCase()?.trim();
      const password = (data.password as string)?.trim();
      const rePassword = (data.re_password as string)?.trim();
      const signupPrefill = getSignupPrefill(email, data);

      // Initialize i18n for error messages
      const locale = context.language || "en";
      const { m } = createTranslation(
        "signup",
        "signup",
        locale,
        context.customText,
      );

      // Validate required fields
      if (!email) {
        const errorMessage = m["no-email"]();
        return {
          error: errorMessage,
          screen: await signupScreen({
            ...context,
            prefill: signupPrefill,
            errors: { email: errorMessage },
          }),
        };
      }

      if (!password) {
        const errorMessage = m["no-password"]();
        return {
          error: errorMessage,
          screen: await signupScreen({
            ...context,
            prefill: signupPrefill,
            errors: { password: errorMessage },
          }),
        };
      }

      if (!rePassword) {
        const errorMessage = m.confirmPasswordRequired();
        return {
          error: errorMessage,
          screen: await signupScreen({
            ...context,
            prefill: signupPrefill,
            errors: { re_password: errorMessage },
          }),
        };
      }

      // Check passwords match
      if (password !== rePassword) {
        const errorMessage = m.passwordsDidntMatch();
        return {
          error: errorMessage,
          screen: await signupScreen({
            ...context,
            prefill: signupPrefill,
            errors: { re_password: errorMessage },
          }),
        };
      }

      // Enforce the stored partial's constraints; the browser is only a hint.
      const partialFields = await getSignupPartialFields(context);
      const partialError = validatePartialFields(partialFields, data);
      if (partialError) {
        return {
          error: partialError.message,
          screen: await signupScreen({
            ...context,
            prefill: signupPrefill,
            errors: { [partialError.name]: partialError.message },
          }),
        };
      }

      // Find the password connection from the client's connections
      const passwordConnection = client.connections.find((c) =>
        isDatabaseConnectionStrategy(c.strategy),
      );
      const connection = passwordConnection?.name || Strategy.USERNAME_PASSWORD;

      // Validate password against connection policy
      const policy = await getPasswordPolicy(
        ctx.env.data,
        client.tenant.id,
        connection,
      );

      try {
        await validatePasswordPolicy(policy, {
          tenantId: client.tenant.id,
          userId: "", // No user yet for signup
          newPassword: password,
          data: ctx.env.data,
        });
      } catch (policyError: unknown) {
        const errorMessage = localizePasswordPolicyError(
          policyError,
          locale,
          context.customText,
        );

        return {
          error: errorMessage,
          screen: await signupScreen({
            ...context,
            prefill: signupPrefill,
            errors: { password: errorMessage },
          }),
        };
      }

      // Check if user already exists
      const existingUser = await getUsernamePasswordUser({
        env: ctx.env,
        tenant_id: client.tenant.id,
        username: email,
      });

      if (existingUser) {
        const errorMessage = m["email-already-exists"]();
        return {
          error: errorMessage,
          screen: await signupScreen({
            ...context,
            prefill: signupPrefill,
            errors: { email: errorMessage },
          }),
        };
      }

      // Get the login session
      const loginSession = await ctx.env.data.loginSessions.get(
        client.tenant.id,
        state,
      );

      if (!loginSession) {
        const errorMessage = m.sessionExpired();
        return {
          error: errorMessage,
          screen: await signupScreen({
            ...context,
            prefill: signupPrefill,
            errors: { email: errorMessage },
          }),
        };
      }

      // Update the login session with the username
      loginSession.authParams.username = email;
      await ctx.env.data.loginSessions.update(
        client.tenant.id,
        loginSession.id,
        { authParams: loginSession.authParams },
      );

      const provider = await resolveUsernamePasswordProvider(
        ctx.env,
        client.tenant.id,
      );
      const user_id = `${provider}|${userIdGenerate()}`;

      // Hash password first
      const { hash, algorithm } = await hashPassword(password);

      let newUser: User;

      try {
        const signupBody = Object.fromEntries(
          Object.entries(data).filter(([key]) => key.startsWith("ulp-")),
        );
        if (Object.keys(signupBody).length > 0) {
          ctx.set("signup_body", signupBody);
        }

        // Create the new user with password atomically in a single transaction
        newUser = await ctx.env.data.users.create(client.tenant.id, {
          user_id,
          email,
          email_verified: false,
          provider,
          connection,
          is_social: false,
          password: { hash, algorithm },
          // Mappings come from the stored partial, never from the request.
          ...applyPartialMappings(partialFields, data),
        });
      } catch (err: any) {
        if (err instanceof SignupValidationError) {
          return {
            error: err.message,
            screen: await signupScreen({
              ...context,
              prefill: getSignupPrefill(email, ctx.var.signup_body),
            }),
          };
        }

        console.log("Err: " + err.message);
        const errorMessage = m.createUserFailed();
        return {
          error: errorMessage,
          screen: await signupScreen({
            ...context,
            prefill: signupPrefill,
            errors: { email: errorMessage },
          }),
        };
      }

      logMessage(ctx, client.tenant.id, {
        type: LogTypes.SUCCESS_SIGNUP,
        description: "Successful signup",
        userId: user_id,
        username: email,
        connection,
        strategy: Strategy.USERNAME_PASSWORD,
        strategy_type: StrategyType.DATABASE,
      });

      // Extract language from ui_locales
      const language = loginSession.authParams?.ui_locales
        ?.split(" ")
        ?.map((locale: string) => locale.split("-")[0])[0];

      // When verification is enforced the login below sends it (code or
      // link, per the connection) and shows the matching screen; sending here
      // too would email the user twice.
      if (client.client_metadata?.email_validation !== "enforced") {
        // Send verification email - wrapped in try/catch to prevent signup
        // failure if email sending fails. User can always re-request
        // verification later.
        try {
          await sendValidateEmailAddress(ctx, newUser, language, {
            client_id: client.client_id,
            redirect_uri: loginSession.authParams.redirect_uri,
          });
        } catch (emailError) {
          console.error("Failed to send verification email:", emailError);
          // Continue with signup - email verification can be retried later
        }
      }

      // Try to log in the user
      try {
        const result = await loginWithPassword(
          ctx,
          client,
          {
            ...loginSession.authParams,
            password,
          },
          loginSession,
          undefined,
          undefined,
          await getLoginEmailVerification(context),
        );

        // Get the redirect URL from the response
        const location = result.headers.get("location");
        // Extract Set-Cookie headers to pass to the caller
        const cookies = result.headers.getSetCookie?.() || [];
        if (location) {
          return { redirect: location, cookies };
        }
        // For non-redirect responses (e.g., web_message mode), pass through directly
        return { response: result };
      } catch (e: unknown) {
        if (e instanceof AuthError && e.code === "EMAIL_NOT_VERIFIED") {
          return {
            screen: await emailVerificationRequiredScreen(context, email),
          };
        }
        // Login failed but user was created, show message about verification
        return {
          screen: await signupScreen({
            ...context,
            messages: [{ text: m.verifyEmailText(), type: "success" }],
          }),
        };
      }
    },
  },
};
