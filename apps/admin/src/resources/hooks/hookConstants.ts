/**
 * Centralized hook metadata: templates, triggers, and helper functions.
 *
 * Both the Create and Edit views import from here so that names,
 * descriptions, and trigger mappings stay in sync.
 */

export interface HookTemplateMeta {
  name: string;
  description: string;
  trigger_ids: string[];
}

/**
 * Registry of available hook templates.
 * Each template maps to a pre-defined hook function on the server side.
 */
export const hookTemplates: Record<string, HookTemplateMeta> = {
  "ensure-username": {
    name: "Ensure Username",
    description:
      "Automatically assigns a username to users who sign in without one",
    trigger_ids: ["post-user-login"],
  },
  "set-preferred-username": {
    name: "Set Preferred Username",
    description:
      "Sets the preferred_username claim on tokens based on the username from the primary or linked user",
    trigger_ids: ["credentials-exchange"],
  },
  "account-linking": {
    name: "Account Linking",
    description:
      "Links a user to an existing primary account with the same verified email. Idempotent — safe to run on every login.",
    trigger_ids: [
      "post-user-login",
      "post-user-registration",
      "post-user-update",
    ],
  },
};

/** All trigger IDs that have at least one template. */
export const triggerIdsWithTemplates = new Set(
  Object.values(hookTemplates).flatMap((t) => t.trigger_ids),
);

/** Build template choices, optionally filtered by trigger_id. */
export function getTemplateChoicesForTrigger(triggerId?: string) {
  return Object.entries(hookTemplates)
    .filter(([, meta]) => !triggerId || meta.trigger_ids.includes(triggerId))
    .map(([id, meta]) => ({
      id,
      name: `${meta.name} — ${meta.description}`,
    }));
}

/** All supported trigger types for hooks. */
export const triggerChoices = [
  {
    id: "validate-registration-username",
    name: "Validate Registration Username",
  },
  { id: "pre-user-registration", name: "Pre User Registration" },
  { id: "post-user-registration", name: "Post User Registration" },
  { id: "post-user-login", name: "Post User Login" },
  { id: "credentials-exchange", name: "Credentials Exchange" },
  { id: "pre-user-update", name: "Pre User Update" },
  { id: "post-user-update", name: "Post User Update" },
  { id: "pre-user-deletion", name: "Pre User Deletion" },
  { id: "post-user-deletion", name: "Post User Deletion" },
];

/** Display names shared by hooks and Actions, including Auth0's post-login alias. */
export function getTriggerName(triggerId?: string): string {
  if (!triggerId) return "—";
  if (triggerId === "custom-token-exchange") return "Custom Token Exchange";
  const hookTriggerId =
    triggerId === "post-login" ? "post-user-login" : triggerId;
  return (
    triggerChoices.find((choice) => choice.id === hookTriggerId)?.name ??
    triggerId
  );
}

/** Trigger choices narrowed to only those that have templates. */
export const triggerChoicesWithTemplatesOnly = triggerChoices.filter((c) =>
  triggerIdsWithTemplates.has(c.id),
);

/**
 * Built-in universal-login pages a page hook can interrupt the login with.
 * Mirrors `hookPageId` in adapter-interfaces — keep the two in sync.
 */
export const pageChoices = [
  {
    id: "impersonate",
    name: "Impersonate — lets permitted users sign in as another user",
  },
];

/** Page hooks only run after authentication, so only on post-user-login. */
export const pageHookTriggerChoices = triggerChoices.filter(
  (c) => c.id === "post-user-login",
);

/**
 * Form hooks need an interactive request to redirect and a login session to
 * resume into, which only post-user-login has — mirrors
 * `formHookAllowedTriggers` in adapter-interfaces. Offering the rest just
 * produced a hook that stored fine and then never ran.
 */
export const formHookTriggerChoices = triggerChoices.filter(
  (c) => c.id === "post-user-login",
);

/**
 * Trigger choices for a hook type, as the management API's schema union
 * accepts them. Unknown/webhook types keep the full list.
 */
export function getTriggerChoicesForType(type?: string) {
  switch (type) {
    case "form":
      return formHookTriggerChoices;
    case "page":
      return pageHookTriggerChoices;
    case "code":
      return codeHookTriggerChoices;
    case "url":
      return webhookTriggerChoices;
    case "template":
      return triggerChoicesWithTemplatesOnly;
    default:
      return triggerChoices;
  }
}

/** Webhook triggers supported by the management API and runtime. */
export const webhookTriggerChoices = triggerChoices.filter(
  (c) => !["credentials-exchange", "pre-user-update"].includes(c.id),
);

export const bindingTypeChoices = [
  { id: "code", name: "Action" },
  { id: "url", name: "Webhook" },
  { id: "form", name: "Form" },
  { id: "template", name: "Template" },
  { id: "page", name: "Page" },
] as const;

export type BindingType = (typeof bindingTypeChoices)[number]["id"];

export function getBindingTypeChoices(triggerId?: string) {
  return bindingTypeChoices.filter(
    (type) =>
      !triggerId ||
      getTriggerChoicesForType(type.id).some((t) => t.id === triggerId),
  );
}

/** Trigger IDs supported by code hooks. */
export const codeHookTriggerChoices = triggerChoices.filter((c) =>
  [
    "validate-registration-username",
    "post-user-login",
    "credentials-exchange",
    "pre-user-registration",
    "post-user-registration",
    "pre-user-update",
    "post-user-update",
    "pre-user-deletion",
    "post-user-deletion",
  ].includes(c.id),
);

/**
 * Maps trigger IDs to the expected export function name for code hooks and
 * actions. Actions use Auth0's trigger ids (`post-login`), hooks AuthHero's
 * (`post-user-login`), so both spellings are listed.
 *
 * `custom-token-exchange` is deliberately absent from the trigger choices
 * above: its actions are referenced by a token exchange profile, never bound
 * to a trigger.
 */
export const triggerHandlerNames: Record<string, string> = {
  "validate-registration-username": "onExecuteValidateRegistrationUsername",
  "post-user-login": "onExecutePostLogin",
  "post-login": "onExecutePostLogin",
  "credentials-exchange": "onExecuteCredentialsExchange",
  "pre-user-registration": "onExecutePreUserRegistration",
  "post-user-registration": "onExecutePostUserRegistration",
  "pre-user-update": "onExecutePreUserUpdate",
  "post-user-update": "onExecutePostUserUpdate",
  "pre-user-deletion": "onExecutePreUserDeletion",
  "post-user-deletion": "onExecutePostUserDeletion",
  "custom-token-exchange": "onExecuteCustomTokenExchange",
};

const CUSTOM_TOKEN_EXCHANGE_TEMPLATE = `/**
 * Runs when a client exchanges a subject token at /oauth/token with the
 * subject_token_type of a token exchange profile that uses this action.
 * Call exactly one of api.authentication.setUserById / setUserByConnection,
 * or reject the request.
 */
exports.onExecuteCustomTokenExchange = async (event, api) => {
  const claims = await verifySubjectToken(event);
  if (!claims) {
    // Counts toward brute-force protection.
    api.access.rejectInvalidSubjectToken("Invalid subject token");
    return;
  }

  api.authentication.setUserByConnection(
    "my-connection",
    {
      user_id: claims.sub,
      email: claims.email,
      name: claims.name,
    },
    { creationBehavior: "create_if_not_exists", updateBehavior: "none" },
  );
};

/**
 * Validate event.transaction.subject_token and return the user's claims, or
 * null. Never trust the token unvalidated.
 *
 * Actions cannot load modules such as jose. If the subject token is a JWT
 * signed with a key you can publish as a JWKS, use a profile in
 * "Verify JWT" mode instead: it checks the signature, issuer, audience,
 * lifetime and jti without an action.
 *
 * For opaque tokens, ask the system that issued them. Keep URLs and
 * credentials in the action's secrets (event.secrets).
 */
async function verifySubjectToken(event) {
  const response = await fetch(event.secrets.INTROSPECTION_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: \`Bearer \${event.secrets.INTROSPECTION_TOKEN}\`,
    },
    body: JSON.stringify({ token: event.transaction.subject_token }),
  });
  if (!response.ok) return null;

  // Expected shape: { active: true, sub, email?, name? }
  const result = await response.json();
  return result.active ? result : null;
}
`;

/** Returns the default code template for the given trigger ID. */
export function getDefaultCodeTemplate(triggerId?: string): string {
  if (triggerId === "validate-registration-username") {
    return `exports.onExecuteValidateRegistrationUsername = async (event, api) => {
  // Inspect event.user.email and event.user.connection before signup.
  // Call api.access.deny("Reason") to reject registration.
};
`;
  }
  if (triggerId === "pre-user-update" || triggerId === "pre-user-deletion") {
    return `exports.${triggerHandlerNames[triggerId]} = async (event, api) => {
  // Inspect event.user${triggerId === "pre-user-update" ? " and event.updates" : ""} before the write.
  // Call api.access.deny("Reason") to cancel the operation.
};
`;
  }
  if (triggerId === "post-user-update" || triggerId === "post-user-deletion") {
    return `exports.${triggerHandlerNames[triggerId]} = async (event, api) => {
  // The write has committed. Use event.idempotency_key to deduplicate retries.
  // Add your downstream integration here.
};
`;
  }
  if (triggerId === "custom-token-exchange") {
    return CUSTOM_TOKEN_EXCHANGE_TEMPLATE;
  }
  const handlerName = triggerId && triggerHandlerNames[triggerId];
  if (!handlerName) {
    return `// Replace "onExecuteHandler" with the handler for your trigger
exports.onExecuteHandler = async (event, api) => {
  // Add your custom logic here
};
`;
  }
  return `exports.${handlerName} = async (event, api) => {
  // Add your custom logic here
};
`;
}
