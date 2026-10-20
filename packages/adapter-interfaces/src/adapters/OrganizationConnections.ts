import { OrganizationConnection, OrganizationConnectionInsert } from "../types";
import { CreateOptions } from "../types/ImportMetadata";
import { ListParams } from "../types/ListParams";

export interface ListOrganizationConnectionsCheckpointResponse {
  connections: OrganizationConnection[];
  /** Opaque checkpoint cursor for the next page; absent on the last page. */
  next?: string;
}

// Junction store: one row per (tenant_id, organization_id, connection_id).
// Mirrors Auth0's `/organizations/{id}/enabled_connections` resource.
export interface OrganizationConnectionsAdapter {
  create(
    tenant_id: string,
    organization_id: string,
    params: OrganizationConnectionInsert,
    options?: CreateOptions,
  ): Promise<OrganizationConnection>;

  list(
    tenant_id: string,
    organization_id: string,
  ): Promise<OrganizationConnection[]>;

  /**
   * Checkpoint (from/take) pagination over an organization's enabled
   * connections, ordered by connection id ascending (unique per organization).
   * Separate from `list` because that returns a bare array with nowhere to
   * carry `next`. Optional so existing adapter implementations keep compiling;
   * the management API answers checkpoint requests with 501 when it is
   * missing.
   */
  listCheckpoint?(
    tenant_id: string,
    organization_id: string,
    params?: ListParams,
  ): Promise<ListOrganizationConnectionsCheckpointResponse>;

  get(
    tenant_id: string,
    organization_id: string,
    connection_id: string,
  ): Promise<OrganizationConnection | null>;

  update(
    tenant_id: string,
    organization_id: string,
    connection_id: string,
    params: Partial<Omit<OrganizationConnectionInsert, "connection_id">>,
  ): Promise<OrganizationConnection | null>;

  remove(
    tenant_id: string,
    organization_id: string,
    connection_id: string,
  ): Promise<boolean>;
}
