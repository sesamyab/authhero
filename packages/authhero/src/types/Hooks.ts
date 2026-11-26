import {
  AuthorizationResponseMode,
  AuthorizationResponseType,
  DataAdapters,
  LinkCandidate,
  PreScreenOperation,
  PreScreenPhase,
  RolePermissionInsert,
  User,
} from "@authhero/adapter-interfaces";
import { EnrichedClient } from "../helpers/client";
import { Context } from "hono";
import { Bindings } from "./Bindings";
import { Variables } from "./Variables";

// ============================================================================
// Entity CRUD Hooks
// ============================================================================

/** Context passed to entity hooks */
export interface EntityHookContext {
  tenantId: string;
  adapters: DataAdapters;
}

/** CRUD hooks for entity operations */
export interface EntityHooks<TEntity, TInsert, TUpdate = Partial<TInsert>> {
  beforeCreate?: (ctx: EntityHookContext, data: TInsert) => Promise<TInsert>;
  afterCreate?: (ctx: EntityHookContext, entity: TEntity) => Promise<void>;
  beforeUpdate?: (
    ctx: EntityHookContext,
    id: string,
    data: TUpdate,
  ) => Promise<TUpdate>;
  afterUpdate?: (
    ctx: EntityHookContext,
    id: string,
    entity: TEntity,
  ) => Promise<void>;
  beforeDelete?: (ctx: EntityHookContext, id: string) => Promise<void>;
  afterDelete?: (ctx: EntityHookContext, id: string) => Promise<void>;
}

/** Hooks for role permission assign/remove operations */
export interface RolePermissionHooks {
  beforeAssign?: (
    ctx: EntityHookContext,
    roleId: string,
    permissions: RolePermissionInsert[],
  ) => Promise<RolePermissionInsert[]>;
  afterAssign?: (
    ctx: EntityHookContext,
    roleId: string,
    permissions: RolePermissionInsert[],
  ) => Promise<void>;
  beforeRemove?: (
    ctx: EntityHookContext,
    roleId: string,
    permissions: Pick<
      RolePermissionInsert,
      "resource_server_identifier" | "permission_name"
    >[],
  ) => Promise<
    Pick<
      RolePermissionInsert,
      "resource_server_identifier" | "permission_name"
    >[]
  >;
  afterRemove?: (
    ctx: EntityHookContext,
    roleId: string,
    permissions: Pick<
      RolePermissionInsert,
      "resource_server_identifier" | "permission_name"
    >[],
  ) => Promise<void>;
}

// ============================================================================
// Auth0-style Action Hooks
// ============================================================================

export type Transaction = {
  id?: string;
  locale: string;
  login_hint?: string;
  prompt?: string;
  redirect_uri?: string;
  requested_scopes?: string[];
  response_mode?: AuthorizationResponseMode;
  response_type?: AuthorizationResponseType;
  state?: string;
  ui_locales?: string;
};

export type HookRequest = {
  asn?: string;
  body?: Record<string, unknown>;
  geoip?: {
    cityName?: string;
    continentCode?: string;
    countryCode?: string;
    latitude?: number;
    longitude?: number;
    subdivisionCode?: string;
    subdivisionName?: string;
    timeZone?: string;
  };
  hostname?: string;
  ip: string;
  language?: string;
  method: string;
  user_agent?: string;
  url: string;
};

export type HookEvent = {
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>;
  client?: EnrichedClient;
  request: HookRequest;
  transaction?: Transaction;
  user?: User;
  scope?: string;
  grant_type?: string;
  audience?: string;
  authentication?: {
    methods: Array<{
      name: string;
      timestamp?: string;
    }>;
  };
  authorization?: {
    roles: string[];
  };
  connection?: {
    id: string;
    name: string;
    strategy: string;
    metadata?: Record<string, unknown>;
  };
  organization?: {
    id: string;
    name: string;
    display_name?: string;
    metadata?: Record<string, unknown>;
  };
  resource_server?: {
    identifier: string;
  };
  stats?: {
    logins_count: number;
  };
  tenant?: {
    id: string;
  };
  session?: {
    id?: string;
    created_at?: string;
    authenticated_at?: string;
    clients?: Array<{ client_id: string }>;
    device?: {
      initial_ip?: string;
      initial_user_agent?: string;
      last_ip?: string;
      last_user_agent?: string;
    };
    /**
     * Present when the session was created by redeeming a
     * session_transfer_token. `parent_refresh_token.id` is the rotation family
     * of the refresh token the token was minted from.
     */
    session_transfer?: {
      client_id: string;
      parent_refresh_token: { id: string };
    };
  };
  /**
   * Present on the login that redeemed a session_transfer_token. `client_id`
   * is the client that minted it and `request` describes the minting request.
   */
  session_transfer_token?: {
    client_id: string;
    scope?: string;
    request: { ip: string; asn?: string; user_agent?: string };
  };
  security_context?: {
    ja3?: string;
    ja4?: string;
  };
  /**
   * Candidate primary accounts the built-in email-linking policy would consider,
   * exposed only to `post-user-login` code hooks that opt in via
   * `metadata.resolve_link_candidates`. Absent on the event for every other hook
   * (and trigger).
   */
  link_candidates?: LinkCandidate[];
};

export type TokenAPI = {
  createServiceToken: (params: {
    scope: string;
    expiresInSeconds?: number;
    customClaims?: Record<string, unknown>;
  }) => Promise<string>;
};

export type OnExecuteCredentialsExchangeAPI = {
  accessToken: {
    setCustomClaim: (claim: string, value: any) => void;
  };
  idToken: {
    setCustomClaim: (claim: string, value: any) => void;
  };
  access: {
    deny: (code: string, reason?: string) => void;
  };
  token: TokenAPI;
};

export type OnExecuteCredentialsExchange = (
  event: HookEvent,
  access: OnExecuteCredentialsExchangeAPI,
) => Promise<void>;

export type OnExecutePreUserRegistrationAPI = {
  user: {
    setUserMetadata: (key: string, value: any) => void;
    setAppMetadata: (key: string, value: any) => void;
    setLinkedTo: (primaryUserId: string) => void;
  };
  access: {
    deny: (code: string, reason?: string) => void;
  };
  validation: {
    error: (code: string, message: string) => void;
  };
  token: TokenAPI;
};

export type OnExecutePostUserRegistrationAPI = {
  user: {};
  token: TokenAPI;
};

export type OnExecutePreUserRegistration = (
  event: HookEvent,
  api: OnExecutePreUserRegistrationAPI,
) => Promise<void>;

export type OnExecutePostUserRegistration = (
  event: HookEvent,
  api: OnExecutePostUserRegistrationAPI,
) => Promise<void>;

export type OnExecutePreUserUpdateAPI = {
  user: {
    setUserMetadata: (key: string, value: any) => void;
  };
  cancel: () => void;
  token: TokenAPI;
};

export type OnExecutePreUserUpdate = (
  event: HookEvent & { user_id: string; updates: Partial<User> },
  api: OnExecutePreUserUpdateAPI,
) => Promise<void>;

export type OnExecutePostUserUpdateAPI = {
  token: TokenAPI;
};

export type OnExecutePostUserUpdate = (
  event: HookEvent & { user_id: string; updates: Partial<User> },
  api: OnExecutePostUserUpdateAPI,
) => Promise<void>;

export type OnExecutePostLoginAPI = {
  prompt: {
    render: (formId: string) => void;
  };
  /**
   * Require MFA for this login (Auth0's `api.multifactor`). Any provider other
   * than `"none"` requires MFA with any factor the tenant has enabled;
   * `"none"` never removes MFA required by the tenant policy or another action.
   */
  multifactor: {
    enable: (
      provider: string,
      options?: { allowRememberBrowser?: boolean },
    ) => void;
  };
  redirect: {
    sendUserTo: (
      url: string,
      options?: { query?: Record<string, string> },
    ) => void;
    encodeToken: (options: {
      secret: string;
      payload: Record<string, any>;
      expiresInSeconds?: number;
    }) => string;
    validateToken: (options: {
      secret: string;
      tokenParameterName?: string;
    }) => Record<string, any> | null;
  };
  token: TokenAPI;
};

export type OnExecutePostLogin = (
  event: HookEvent,
  api: OnExecutePostLoginAPI,
) => Promise<void>;

export type OnExecutePreUserDeletionAPI = {
  cancel: () => void;
  token: TokenAPI;
};

export type OnExecutePreUserDeletion = (
  event: HookEvent & { user_id: string },
  api: OnExecutePreUserDeletionAPI,
) => Promise<void>;

export type OnExecutePostUserDeletionAPI = {
  token: TokenAPI;
};

export type OnExecutePostUserDeletion = (
  event: HookEvent & { user_id: string },
  api: OnExecutePostUserDeletionAPI,
) => Promise<void>;

/**
 * The authorization request a universal-login screen belongs to, plus the
 * phase the `pre-screen` trigger runs in. The login session id is not
 * included: it is the key to the transaction, not a request parameter.
 */
export type PreScreenTransaction = {
  /** `render` before the screen is shown, `submit` when it is submitted. */
  phase: PreScreenPhase;
  locale: string;
  client_id?: string;
  redirect_uri?: string;
  requested_scopes: string[];
  response_type?: AuthorizationResponseType;
  response_mode?: AuthorizationResponseMode;
  /** The application's `state` parameter. */
  state?: string;
  audience?: string;
  prompt?: string;
  ui_locales?: string;
  acr_values?: string;
  /** The identifier entered or passed as `login_hint` so far. */
  login_hint?: string;
  /** `screen_hint` from the authorization request. */
  screen_hint?: string;
};

/**
 * Event of the `pre-screen` trigger (an AuthHero extension; Auth0 has no
 * pre-login trigger). Fires before a universal-login screen is shown and when
 * it is submitted.
 */
export type PreScreenEvent = {
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>;
  screen: { name: string };
  prompt: { name: string };
  transaction: PreScreenTransaction;
  /**
   * Submit phase only: the operation the submission performs, e.g.
   * `remove-mfa` for the remove button on `account-security`.
   */
  operation?: PreScreenOperation;
  /** Operation-specific detail, e.g. `{ factor: "totp" }` for `enroll-mfa`. */
  details?: Record<string, string>;
  /**
   * The user when known: the signed-in user on account screens, the user the
   * identifier entered so far matches on login and password-reset screens,
   * the authenticated user on MFA and consent screens.
   */
  user?: User;
  /** Connection of the user's primary identity. */
  connection?: { id?: string; name: string; strategy?: string };
  client?: EnrichedClient;
  organization?: {
    id: string;
    name: string;
    display_name?: string;
    metadata?: Record<string, unknown>;
  };
  tenant: { id: string };
  request: HookRequest;
};

export type OnExecutePreScreenAPI = {
  redirect: {
    /** Send the user to `url` instead of showing or submitting the screen. */
    sendUserTo: (
      url: string,
      options?: { query?: Record<string, string> },
    ) => void;
  };
  access: {
    /** Stop the screen and show `reason` to the user. */
    deny: (reason?: string) => void;
  };
  token: TokenAPI;
};

export type OnExecutePreScreen = (
  event: PreScreenEvent,
  api: OnExecutePreScreenAPI,
) => Promise<void>;

export type OnExecuteValidateRegistrationUsernameAPI = {
  deny: (reason?: string) => void;
  token: TokenAPI;
};

export type OnExecuteValidateRegistrationUsername = (
  event: Omit<HookEvent, "user"> & {
    user: { email: string; connection: string };
  },
  api: OnExecuteValidateRegistrationUsernameAPI,
) => Promise<void>;

// ============================================================================
// Userinfo Hook
// ============================================================================

export type UserInfoEvent = {
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>;
  user: User;
  tenant_id: string;
  scopes: string[];
};

export type OnFetchUserInfoAPI = {
  setCustomClaim: (claim: string, value: unknown) => void;
};

/** Called when /userinfo endpoint is accessed */
export type OnFetchUserInfo = (
  event: UserInfoEvent,
  api: OnFetchUserInfoAPI,
) => Promise<void>;

// ============================================================================
// Shared Hooks Type
// ============================================================================

/**
 * All available auth flow hooks.
 * This type is shared between AuthHeroConfig and Bindings to ensure consistency.
 */
export type Hooks = {
  onExecuteCredentialsExchange?: OnExecuteCredentialsExchange;
  onExecutePreUserRegistration?: OnExecutePreUserRegistration;
  onExecutePostUserRegistration?: OnExecutePostUserRegistration;
  onExecutePreUserUpdate?: OnExecutePreUserUpdate;
  onExecutePostUserUpdate?: OnExecutePostUserUpdate;
  onExecutePostLogin?: OnExecutePostLogin;
  onExecutePreUserDeletion?: OnExecutePreUserDeletion;
  onExecutePostUserDeletion?: OnExecutePostUserDeletion;
  onExecuteValidateRegistrationUsername?: OnExecuteValidateRegistrationUsername;
  /**
   * Called before a universal-login screen is shown and when it is submitted
   * (AuthHero extension, the `pre-screen` trigger)
   */
  onExecutePreScreen?: OnExecutePreScreen;
  /** Called when /userinfo endpoint is accessed to add custom claims */
  onFetchUserInfo?: OnFetchUserInfo;
};
