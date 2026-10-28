import type {
  TenantMemberRequest,
  TenantMemberRequestInsert,
  TenantMemberRequestStatus,
  TenantMemberRequestUpdate,
} from "../types/TenantMemberRequest";
import type { ListParams } from "../types/ListParams";

export interface ListTenantMemberRequestsParams extends ListParams {
  status?: TenantMemberRequestStatus | TenantMemberRequestStatus[];
  /**
   * `true`: only requests the control plane has not acknowledged yet
   * (`notified_at` unset). The reconcile job reads these.
   */
  unnotified?: boolean;
  /** Only requests created before this instant (ISO 8601). */
  created_before?: string;
}

export interface ListTenantMemberRequestsResult {
  requests: TenantMemberRequest[];
  start: number;
  limit: number;
  length: number;
}

/**
 * Team-change requests of a tenant (issue #1550), stored in the tenant's own
 * database. Every method but `cleanup` is scoped to one tenant.
 */
export interface TenantMemberRequestsAdapter {
  /** Generates the `tmr_<nanoid>` id and inserts with status `pending`. */
  create(
    tenantId: string,
    request: TenantMemberRequestInsert,
  ): Promise<TenantMemberRequest>;
  get(tenantId: string, id: string): Promise<TenantMemberRequest | null>;
  /** Default sort: `created_at` descending. */
  list(
    tenantId: string,
    params?: ListTenantMemberRequestsParams,
  ): Promise<ListTenantMemberRequestsResult>;
  /**
   * Always bumps `updated_at`. With `expectedStatus` the update only applies
   * while the row still has that status, which is how a `pending` request is
   * finished exactly once. Returns whether a row was updated.
   */
  update(
    tenantId: string,
    id: string,
    patch: TenantMemberRequestUpdate,
    expectedStatus?: TenantMemberRequestStatus,
  ): Promise<boolean>;
  /** Deletes finished requests (`succeeded` or `failed`) finished before `olderThan`, across tenants. */
  cleanup(olderThan: string): Promise<number>;
}
