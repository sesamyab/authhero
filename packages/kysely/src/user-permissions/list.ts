import { Kysely, sql, SqlBool } from "kysely";
import { HTTPException } from "hono/http-exception";
import { Database } from "../db";
import {
  ListParams,
  ListUserPermissionsCheckpointResponse,
  UserPermissionWithDetails,
  decodeCursor,
  encodeCursor,
} from "@authhero/adapter-interfaces";

function baseQuery(
  db: Kysely<Database>,
  tenant_id: string,
  user_id: string,
  organization_id?: string,
) {
  {
    let query = db
      .selectFrom("user_permissions")
      .leftJoin("resource_servers", (join) =>
        join
          .onRef(
            "user_permissions.tenant_id",
            "=",
            "resource_servers.tenant_id",
          )
          .onRef(
            "user_permissions.resource_server_identifier",
            "=",
            "resource_servers.identifier",
          ),
      )
      .select([
        "user_permissions.resource_server_identifier",
        "user_permissions.permission_name",
        "resource_servers.name as resource_server_name",
        "user_permissions.user_id",
        "user_permissions.created_at",
        "user_permissions.organization_id",
      ])
      .where("user_permissions.tenant_id", "=", tenant_id)
      .where("user_permissions.user_id", "=", user_id);

    // Add organization filter if provided
    if (organization_id !== undefined) {
      query = query.where(
        "user_permissions.organization_id",
        "=",
        organization_id,
      );
    }

    return query;
  }
}

type Row = {
  resource_server_identifier: string;
  permission_name: string;
  resource_server_name: string | null;
  user_id: string;
  created_at?: string;
  organization_id?: string;
};

function toPermission(result: Row): UserPermissionWithDetails {
  return {
    resource_server_identifier: result.resource_server_identifier,
    permission_name: result.permission_name,
    description: null, // No description available from user_permissions directly
    resource_server_name:
      result.resource_server_name || result.resource_server_identifier, // Fallback to identifier if name is null
    user_id: result.user_id,
    created_at: result.created_at,
    organization_id:
      result.organization_id === "" ? undefined : result.organization_id,
  };
}

export function list(db: Kysely<Database>) {
  return async (
    tenant_id: string,
    user_id: string,
    _params?: ListParams, // TODO: Implement offset pagination when needed
    organization_id?: string,
  ): Promise<UserPermissionWithDetails[]> => {
    const results = await baseQuery(
      db,
      tenant_id,
      user_id,
      organization_id,
    ).execute();
    return results.map(toPermission);
  };
}

// Checkpoint (from/take) pagination. The composite key
// (resource_server_identifier, permission_name, organization_id) is unique per
// user, so it serves as sort + tiebreaker without a surrogate id. The cursor
// carries the first column in `s` and the other two in `i` as a JSON pair.
export function listCheckpoint(db: Kysely<Database>) {
  return async (
    tenant_id: string,
    user_id: string,
    params: ListParams = {},
    organization_id?: string,
  ): Promise<ListUserPermissionsCheckpointResponse> => {
    const raw = params.take;
    const take =
      typeof raw === "number" && Number.isFinite(raw) && Math.floor(raw) >= 1
        ? Math.floor(raw)
        : 50;

    let query = baseQuery(db, tenant_id, user_id, organization_id);

    const cursor = params.from ? decodeCursor(params.from) : null;
    if (cursor) {
      if (cursor.k !== undefined) {
        throw new HTTPException(400, {
          message:
            "The `from` cursor was issued under a different sort and cannot be used with this request",
        });
      }
      const [permission, org] = JSON.parse(cursor.i) as [string, string];
      query = query.where(
        sql<SqlBool>`(user_permissions.resource_server_identifier, user_permissions.permission_name, user_permissions.organization_id) > (${cursor.s}, ${permission}, ${org})`,
      );
    }

    const fetched = await query
      .orderBy("user_permissions.resource_server_identifier", "asc")
      .orderBy("user_permissions.permission_name", "asc")
      .orderBy("user_permissions.organization_id", "asc")
      .limit(take + 1)
      .execute();

    const hasMore = fetched.length > take;
    const rows = hasMore ? fetched.slice(0, take) : fetched;
    const last = rows[rows.length - 1];
    const next =
      hasMore && last
        ? encodeCursor({
            s: last.resource_server_identifier,
            i: JSON.stringify([
              last.permission_name,
              last.organization_id ?? "",
            ]),
          })
        : undefined;

    return { permissions: rows.map(toPermission), next };
  };
}
