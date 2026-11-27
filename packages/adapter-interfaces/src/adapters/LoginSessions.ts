import { LoginSession, LoginSessionInsert } from "../types";

export interface LoginSessionsAdapter {
  create: (
    tenant_id: string,
    session: LoginSessionInsert,
  ) => Promise<LoginSession>;
  update: (
    tenant_id: string,
    id: string,
    session: Partial<LoginSession>,
  ) => Promise<boolean>;
  /**
   * Compare-and-swap on `state_data`: apply `session` only if the stored
   * `state_data` still equals `expected_state_data`, as one atomic write.
   * A missing, null or empty stored value matches an `undefined` or empty
   * `expected_state_data`. Resolves false, without writing, when the value
   * changed or the session does not exist.
   *
   * Optional: callers fall back to a plain `update` (best effort, not atomic)
   * when an adapter does not implement it.
   */
  updateIfStateDataUnchanged?: (
    tenant_id: string,
    id: string,
    expected_state_data: string | undefined,
    session: Partial<LoginSession>,
  ) => Promise<boolean>;
  get: (tenant_id: string, id: string) => Promise<LoginSession | null>;
  remove: (tenant_id: string, id: string) => Promise<boolean>;
}
