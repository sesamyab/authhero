/**
 * The API exposed inside a code Action, rather than the larger server-side
 * Hooks API. Executors record these calls and the host applies them after the
 * handler completes, so every method returns void, including account linking.
 *
 * scripts/generate-code-hook-api-types.mjs turns these types into the runtime
 * declarations supplied to code generators. Keep them aligned with
 * TRIGGER_API_SHAPES and the corresponding host replay implementations.
 */
export type CodeHookApiTrigger = keyof CodeHookApiByTrigger;

export interface ActionClaimAPI {
  /** Values must be JSON serializable. Reserved token claims cannot be set. */
  setCustomClaim(claim: string, value: unknown): void;
}

export interface ActionAccessAPI {
  /** Deny with an error code and an optional human-readable reason. */
  deny(code: string, reason?: string): void;
}

export interface ActionBlockingAccessAPI {
  /** Cancel registration, update, or deletion with an optional reason. */
  deny(reason?: string): void;
}

export interface ActionLinkAPI {
  /** Records a link request; does not return a user or immediately mutate event.user. */
  setLinkedTo(primaryUserId: string): void;
}

export interface ActionRegistrationUserAPI extends ActionLinkAPI {
  /** Metadata values must be JSON serializable. */
  setUserMetadata(key: string, value: unknown): void;
  setAppMetadata(key: string, value: unknown): void;
}

export interface ActionRedirectAPI {
  /** Query values are appended to the URL; they must be strings. */
  sendUserTo(url: string, options?: { query?: Record<string, string> }): void;
}

export interface ActionAccountAccessAPI {
  /** Stop the account operation and show the reason to the user. */
  deny(reason?: string): void;
}

export interface ActionMultifactorEnableOptions {
  /** Recorded with the request; remembering the browser is not supported yet. */
  allowRememberBrowser?: boolean;
}

export interface ActionMultifactorAPI {
  /**
   * Require MFA for this login with any factor the tenant has enabled.
   * `"none"` never removes MFA required by the tenant policy or another action.
   */
  enable(provider: string, options?: ActionMultifactorEnableOptions): void;
}

export interface ActionExchangeUserAttributes {
  /** The user's id within the named connection, not a full AuthHero user_id. */
  user_id: string;
  email?: string;
  email_verified?: boolean;
  phone_number?: string;
  phone_verified?: boolean;
  username?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  nickname?: string;
  picture?: string;
}

export interface ActionExchangeUserOptions {
  /** Defaults to create_if_not_exists. */
  creationBehavior?: "create_if_not_exists" | "none";
  /** Defaults to none. */
  updateBehavior?: "replace" | "none";
}

export interface CodeHookApiByTrigger {
  "validate-registration-username": {
    access: ActionBlockingAccessAPI;
  };
  "post-user-login": {
    accessToken: ActionClaimAPI;
    idToken: ActionClaimAPI;
    access: ActionAccessAPI;
    prompt: {
      render(formId: string): void;
    };
    redirect: ActionRedirectAPI;
    user: ActionLinkAPI;
    multifactor: ActionMultifactorAPI;
  };
  "credentials-exchange": {
    accessToken: ActionClaimAPI;
    idToken: ActionClaimAPI;
    access: ActionAccessAPI;
  };
  "pre-user-registration": {
    user: ActionRegistrationUserAPI;
    access: ActionAccessAPI;
    validation: {
      error(code: string, message: string): void;
    };
  };
  "post-user-registration": {};
  "pre-user-update": {
    access: ActionBlockingAccessAPI;
  };
  "post-user-update": {};
  "pre-user-deletion": {
    access: ActionBlockingAccessAPI;
  };
  "post-user-deletion": {};
  "pre-account-action": {
    /** Send the user somewhere else instead of running the operation here. */
    redirect: ActionRedirectAPI;
    access: ActionAccountAccessAPI;
  };
  "custom-token-exchange": {
    /** Validate the subject token, then call exactly one user selector or reject it. */
    authentication: {
      /** Select an existing full AuthHero user_id. */
      setUserById(userId: string): void;
      /** Select a user by connection name and validated user attributes. */
      setUserByConnection(
        connection: string,
        attributes: ActionExchangeUserAttributes,
        options?: ActionExchangeUserOptions,
      ): void;
    };
    access: {
      deny(code: string, reason?: string): void;
      rejectInvalidSubjectToken(reason?: string): void;
    };
  };
}
