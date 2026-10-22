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
import {
  applyPartialMappings,
  getPartialFields,
  getUlpPrefill,
  loadScreenPartials,
  validatePartialFields,
  type PartialSource,
  type PrefillValue,
} from "./partials";
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

export {
  applyPartialErrors,
  applyPartialMappings,
  isValidAuthheroMapTarget,
  parsePartialFields,
  prefillPromptPartial,
  validatePartialFields,
  type PartialField,
} from "./partials";

// Stored under all three prompts; the u2 signup is a single screen.
const SIGNUP_PARTIAL_SOURCES: PartialSource[] = [
  { prompt: "signup-id", screen: "signup-id" },
  { prompt: "signup", screen: "signup" },
  { prompt: "signup-password", screen: "signup-password" },
];

export function getSignupPrefill(
  email: string | undefined,
  signupBody?: Record<string, unknown>,
): Record<string, PrefillValue> {
  return { ...(email ? { email } : {}), ...getUlpPrefill(signupBody) };
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

  const { partials, messages: unplacedErrors } = await loadScreenPartials(
    context,
    SIGNUP_PARTIAL_SOURCES,
  );

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
      const partialFields = await getPartialFields(
        context,
        SIGNUP_PARTIAL_SOURCES,
      );
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
