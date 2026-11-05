import {
  AuthenticationMethod,
  AuthenticationMethodInsert,
  AuthenticationMethodUpdate,
} from "../types/AuthenticationMethod";
import { CreateOptions } from "../types/ImportMetadata";

export interface AuthenticationMethodsAdapter {
  create: (
    tenant_id: string,
    method: AuthenticationMethodInsert,
    options?: CreateOptions,
  ) => Promise<AuthenticationMethod>;
  get: (
    tenant_id: string,
    method_id: string,
  ) => Promise<AuthenticationMethod | null>;
  getByCredentialId: (
    tenant_id: string,
    credential_id: string,
  ) => Promise<AuthenticationMethod | null>;
  list: (tenant_id: string, user_id: string) => Promise<AuthenticationMethod[]>;
  update: (
    tenant_id: string,
    method_id: string,
    data: AuthenticationMethodUpdate,
  ) => Promise<AuthenticationMethod>;
  remove: (tenant_id: string, method_id: string) => Promise<boolean>;
  /**
   * Atomically record `step` as the last accepted TOTP time step, but only if
   * it is greater than the stored `totp_last_step` (or none is stored yet).
   * Returns true if the step was recorded, false if the method does not exist
   * or a code with the same or a later step was already accepted (a replay).
   * The check and the write must be a single conditional update, the same
   * way `codes.consume` works, so two concurrent submits of one code cannot
   * both succeed.
   */
  consumeTotpStep: (
    tenant_id: string,
    method_id: string,
    step: number,
  ) => Promise<boolean>;
}
