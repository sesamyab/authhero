import { eq, and, asc, inArray, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import {
  decodeCursor,
  encodeCursor,
  type ListParams,
  type ListUserPermissionsCheckpointResponse,
} from "@authhero/adapter-interfaces";
import { userPermissions, resourceServers } from "../schema/sqlite";
import { keysetTake } from "../helpers/paginate";
import type { DrizzleDb } from "./types";

// The composite tiebreaker travels as a JSON [permission_name, organization_id]
// pair. A cursor minted by another endpoint (or edited by hand) is a client
// error, not a server one.
function parseCompositeCursor(raw: string): [string, string] {
  try {
    const parsed = JSON.parse(raw);
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed.every((part) => typeof part === "string")
    ) {
      return parsed as [string, string];
    }
  } catch {
    // fall through
  }
  throw new HTTPException(400, { message: "The `from` cursor is not valid" });
}

export function createUserPermissionsAdapter(db: DrizzleDb) {
  return {
    async create(
      tenant_id: string,
      user_id: string,
      permission: {
        resource_server_identifier: string;
        permission_name: string;
      },
      organization_id?: string,
    ): Promise<boolean> {
      try {
        await db.insert(userPermissions).values({
          tenant_id,
          user_id,
          resource_server_identifier: permission.resource_server_identifier,
          permission_name: permission.permission_name,
          organization_id: organization_id || "",
          created_at: new Date().toISOString(),
        });
      } catch (error: any) {
        // Ignore duplicate constraint errors (idempotent)
        if (
          error?.message?.includes("UNIQUE constraint") ||
          error?.message?.includes("SQLITE_CONSTRAINT_PRIMARYKEY")
        ) {
          return true;
        }
        throw error;
      }

      return true;
    },

    async list(
      tenant_id: string,
      user_id: string,
      _params?: any,
      organization_id?: string,
    ) {
      let conditions = [
        eq(userPermissions.tenant_id, tenant_id),
        eq(userPermissions.user_id, user_id),
      ];

      if (organization_id) {
        conditions.push(eq(userPermissions.organization_id, organization_id));
      }

      const results = await db
        .select()
        .from(userPermissions)
        .where(and(...conditions))
        .all();

      const mapped = await Promise.all(
        results.map(async (row) => {
          const rs = await db
            .select({ name: resourceServers.name })
            .from(resourceServers)
            .where(
              and(
                eq(resourceServers.tenant_id, tenant_id),
                eq(resourceServers.identifier, row.resource_server_identifier),
              ),
            )
            .get();

          return {
            resource_server_identifier: row.resource_server_identifier,
            permission_name: row.permission_name,
            resource_server_name: rs?.name || row.resource_server_identifier,
            organization_id:
              row.organization_id === "" ? undefined : row.organization_id,
          };
        }),
      );

      return mapped;
    },

    // Checkpoint (from/take) pagination. The composite key
    // (resource_server_identifier, permission_name, organization_id) is unique
    // per user, so it serves as sort + tiebreaker without a surrogate id. The
    // cursor carries the first column in `s` and the other two in `i` as a
    // JSON pair.
    async listCheckpoint(
      tenant_id: string,
      user_id: string,
      params: ListParams = {},
      organization_id?: string,
    ): Promise<ListUserPermissionsCheckpointResponse> {
      const take = keysetTake(params);
      const conditions = [
        eq(userPermissions.tenant_id, tenant_id),
        eq(userPermissions.user_id, user_id),
      ];
      if (organization_id !== undefined) {
        conditions.push(eq(userPermissions.organization_id, organization_id));
      }

      const cursor = params.from ? decodeCursor(params.from) : null;
      if (cursor) {
        if (cursor.k !== undefined) {
          throw new HTTPException(400, {
            message:
              "The `from` cursor was issued under a different sort and cannot be used with this request",
          });
        }
        const [permission, org] = parseCompositeCursor(cursor.i);
        conditions.push(
          sql`(${userPermissions.resource_server_identifier}, ${userPermissions.permission_name}, ${userPermissions.organization_id}) > (${cursor.s}, ${permission}, ${org})`,
        );
      }

      const fetched = await db
        .select()
        .from(userPermissions)
        .where(and(...conditions))
        .orderBy(
          asc(userPermissions.resource_server_identifier),
          asc(userPermissions.permission_name),
          asc(userPermissions.organization_id),
        )
        .limit(take + 1)
        .all();

      const hasMore = fetched.length > take;
      const rows = hasMore ? fetched.slice(0, take) : fetched;
      const last = rows[rows.length - 1];
      const next =
        hasMore && last
          ? encodeCursor({
              s: last.resource_server_identifier,
              i: JSON.stringify([last.permission_name, last.organization_id]),
            })
          : undefined;

      const identifiers = [
        ...new Set(rows.map((r) => r.resource_server_identifier)),
      ];
      const nameMap = new Map<string, string>();
      if (identifiers.length > 0) {
        const rsRows = await db
          .select({
            identifier: resourceServers.identifier,
            name: resourceServers.name,
          })
          .from(resourceServers)
          .where(
            and(
              eq(resourceServers.tenant_id, tenant_id),
              inArray(resourceServers.identifier, identifiers),
            ),
          )
          .all();
        for (const rs of rsRows) nameMap.set(rs.identifier, rs.name);
      }

      return {
        permissions: rows.map((row) => ({
          user_id: row.user_id,
          resource_server_identifier: row.resource_server_identifier,
          permission_name: row.permission_name,
          resource_server_name:
            nameMap.get(row.resource_server_identifier) ||
            row.resource_server_identifier,
          created_at: row.created_at,
          organization_id:
            row.organization_id === "" ? undefined : row.organization_id,
        })),
        next,
      };
    },

    async remove(
      tenant_id: string,
      user_id: string,
      permission: {
        resource_server_identifier: string;
        permission_name: string;
      },
      organization_id?: string,
    ): Promise<boolean> {
      const results = await db
        .delete(userPermissions)
        .where(
          and(
            eq(userPermissions.tenant_id, tenant_id),
            eq(userPermissions.user_id, user_id),
            eq(
              userPermissions.resource_server_identifier,
              permission.resource_server_identifier,
            ),
            eq(userPermissions.permission_name, permission.permission_name),
            eq(userPermissions.organization_id, organization_id || ""),
          ),
        )
        .returning();

      return results.length > 0;
    },
  };
}
