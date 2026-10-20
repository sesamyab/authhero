import { ListParams } from "../types/ListParams";
import { UserPermissionInsert, UserPermissionWithDetailsList } from "../types";
import { CreateOptions } from "../types/ImportMetadata";

export interface ListUserPermissionsCheckpointResponse {
  permissions: UserPermissionWithDetailsList;
  /** Opaque checkpoint cursor for the next page; absent on the last page. */
  next?: string;
}

export interface UserPermissionsAdapter {
  // Create a single permission for a user
  create(
    tenant_id: string,
    user_id: string,
    permission: UserPermissionInsert,
    organization_id?: string,
    options?: CreateOptions,
  ): Promise<boolean>;

  // Remove a single permission from a user
  remove(
    tenant_id: string,
    user_id: string,
    permission: Pick<
      UserPermissionInsert,
      "resource_server_identifier" | "permission_name"
    >,
    organization_id?: string,
  ): Promise<boolean>;

  // List all permissions for a user (including inherited from roles)
  list(
    tenant_id: string,
    user_id: string,
    params?: ListParams,
    organization_id?: string,
  ): Promise<UserPermissionWithDetailsList>;

  /**
   * Checkpoint (from/take) pagination over a user's permissions, ordered by
   * (resource_server_identifier, permission_name, organization_id) ascending —
   * the composite key. Separate from `list` because that returns a bare array
   * with nowhere to carry `next`. Optional so existing adapter implementations
   * keep compiling; the management API answers checkpoint requests with 501
   * when it is missing.
   */
  listCheckpoint?(
    tenant_id: string,
    user_id: string,
    params?: ListParams,
    organization_id?: string,
  ): Promise<ListUserPermissionsCheckpointResponse>;
}
