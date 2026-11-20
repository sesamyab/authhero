import {
  SelfServiceProfile,
  SelfServiceProfileCustomText,
  SelfServiceProfileInsert,
  SelfServiceProfileUpdate,
} from "../types/SelfServiceProfile";
import {
  SsoAccessTicket,
  SsoAccessTicketInsert,
  SsoAccessTicketUpdate,
} from "../types/SsoAccessTicket";
import {
  ConnectionDomain,
  ConnectionDomainInsert,
  ConnectionDomainUpdate,
  ListConnectionDomainsParams,
} from "../types/ConnectionDomain";
import { CreateOptions } from "../types/ImportMetadata";

/** Self-Service SSO profiles and their custom text (issue #1763). */
export interface SelfServiceProfilesAdapter {
  create(
    tenant_id: string,
    profile: SelfServiceProfileInsert,
    options?: CreateOptions,
  ): Promise<SelfServiceProfile>;
  get(tenant_id: string, id: string): Promise<SelfServiceProfile | null>;
  /**
   * All profiles for the tenant, oldest first. Auth0 caps a tenant at a
   * handful of profiles, so the Management API pages in memory.
   */
  list(tenant_id: string): Promise<SelfServiceProfile[]>;
  update(
    tenant_id: string,
    id: string,
    profile: SelfServiceProfileUpdate,
  ): Promise<boolean>;
  /**
   * Removes the profile together with its custom text and SSO access
   * tickets, so no ticket outlives the profile it was issued from.
   */
  remove(tenant_id: string, id: string): Promise<boolean>;
  /** The custom text for a language and page; `{}` when none is set. */
  getCustomText(
    tenant_id: string,
    profile_id: string,
    language: string,
    page: string,
  ): Promise<SelfServiceProfileCustomText>;
  /** Replaces the custom text for a language and page. */
  setCustomText(
    tenant_id: string,
    profile_id: string,
    language: string,
    page: string,
    custom_text: SelfServiceProfileCustomText,
  ): Promise<void>;
}

/**
 * Self-Service SSO access tickets (issue #1763). Stored by the hash of the
 * ticket id; there is no list, as in Auth0.
 */
export interface SsoAccessTicketsAdapter {
  create(
    tenant_id: string,
    ticket: SsoAccessTicketInsert,
  ): Promise<SsoAccessTicket>;
  /** By internal row id. */
  get(tenant_id: string, id: string): Promise<SsoAccessTicket | null>;
  /** By the hash of the ticket id, within the tenant. */
  getByTicketHash(
    tenant_id: string,
    ticket_hash: string,
  ): Promise<SsoAccessTicket | null>;
  update(
    tenant_id: string,
    id: string,
    ticket: SsoAccessTicketUpdate,
  ): Promise<boolean>;
  remove(tenant_id: string, id: string): Promise<boolean>;
}

/** Email domains claimed by connections and their verification state. */
export interface ConnectionDomainsAdapter {
  create(
    tenant_id: string,
    domain: ConnectionDomainInsert,
  ): Promise<ConnectionDomain>;
  get(tenant_id: string, id: string): Promise<ConnectionDomain | null>;
  /** Oldest first. `domain` matches case-insensitively. */
  list(
    tenant_id: string,
    params?: ListConnectionDomainsParams,
  ): Promise<ConnectionDomain[]>;
  update(
    tenant_id: string,
    id: string,
    domain: ConnectionDomainUpdate,
  ): Promise<boolean>;
  remove(tenant_id: string, id: string): Promise<boolean>;
}
