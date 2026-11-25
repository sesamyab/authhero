import {
  ClientRegistrationToken,
  ClientRegistrationTokenInsert,
  ClientRegistrationTokenSource,
  ClientRegistrationTokenType,
  Totals,
} from "../types";

export interface ListClientRegistrationTokensParams {
  type?: ClientRegistrationTokenType;
  client_id?: string;
  source?: ClientRegistrationTokenSource;
  page?: number;
  per_page?: number;
  include_totals?: boolean;
}

export interface ListClientRegistrationTokensResponse extends Totals {
  client_registration_tokens: ClientRegistrationToken[];
}

export interface ClientRegistrationTokensAdapter {
  create: (
    tenant_id: string,
    token: ClientRegistrationTokenInsert,
  ) => Promise<ClientRegistrationToken>;
  get: (
    tenant_id: string,
    id: string,
  ) => Promise<ClientRegistrationToken | null>;
  getByHash: (
    tenant_id: string,
    token_hash: string,
  ) => Promise<ClientRegistrationToken | null>;
  /** Newest first. */
  list: (
    tenant_id: string,
    params?: ListClientRegistrationTokensParams,
  ) => Promise<ListClientRegistrationTokensResponse>;
  listByClient: (
    tenant_id: string,
    client_id: string,
  ) => Promise<ClientRegistrationToken[]>;
  /**
   * Marks an unused token as used. `client_id`, when given, records the
   * client the token created (an invite links to its app).
   */
  markUsed: (
    tenant_id: string,
    id: string,
    used_at: string,
    client_id?: string,
  ) => Promise<boolean>;
  revoke: (
    tenant_id: string,
    id: string,
    revoked_at: string,
  ) => Promise<boolean>;
  revokeByClient: (
    tenant_id: string,
    client_id: string,
    revoked_at: string,
  ) => Promise<number>;
  remove: (tenant_id: string, id: string) => Promise<boolean>;
}
