import { User } from "@authhero/adapter-interfaces";

export type ExternalUser = Omit<User, "registration_completed_at">;

/**
 * Remove fields that are tracked internally for self-healing/bookkeeping
 * but must never reach customer-facing payloads (webhooks, code hooks,
 * `onExecutePostLogin` event, outbox `target.after`, etc.).
 */
export function stripInternalUserFields(user: User): ExternalUser {
  return sanitizeUserUpdates(user) as ExternalUser;
}

/** Update payloads can arrive from internal callers as well as validated APIs. */
export function sanitizeUserUpdates(updates: Partial<User>): Partial<User> {
  const {
    registration_completed_at: _internal,
    password: _password,
    password_hash: _hash,
    custom_password_hash: _customHash,
    ...rest
  } = updates as Partial<User> & {
    password?: unknown;
    password_hash?: unknown;
    custom_password_hash?: unknown;
  };
  return rest;
}
