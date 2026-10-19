import {
  UserRolesAdapter,
  Role,
  ListParams,
  ListUserRolesCheckpointResponse,
  roleSchema,
} from "@authhero/adapter-interfaces";
import { DynamoDBContext, DynamoDBBaseItem } from "../types";
import { userRoleKeys, roleKeys } from "../keys";
import {
  putItem,
  deleteItem,
  queryItems,
  queryWithPagination,
  getItem,
  stripDynamoDBFields,
  removeNullProperties,
} from "../utils";

interface UserRoleItem extends DynamoDBBaseItem {
  user_id: string;
  tenant_id: string;
  organization_id?: string;
  role_id: string;
}

interface RoleItem extends DynamoDBBaseItem {
  id: string;
  tenant_id: string;
  name: string;
  description?: string;
}

function toRole(item: RoleItem): Role {
  const { tenant_id, ...rest } = stripDynamoDBFields(item);
  return roleSchema.parse(removeNullProperties(rest));
}

export function createUserRolesAdapter(ctx: DynamoDBContext): UserRolesAdapter {
  return {
    async create(
      tenantId: string,
      userId: string,
      roleId: string,
      organizationId?: string,
    ): Promise<boolean> {
      const now = new Date().toISOString();

      const item: UserRoleItem = {
        PK: userRoleKeys.pk(tenantId, userId, organizationId),
        SK: userRoleKeys.sk(roleId),
        entityType: "USER_ROLE",
        tenant_id: tenantId,
        user_id: userId,
        organization_id: organizationId,
        role_id: roleId,
        created_at: now,
        updated_at: now,
      };

      await putItem(ctx, item);

      return true;
    },

    async remove(
      tenantId: string,
      userId: string,
      roleId: string,
      organizationId?: string,
    ): Promise<boolean> {
      return deleteItem(
        ctx,
        userRoleKeys.pk(tenantId, userId, organizationId),
        userRoleKeys.sk(roleId),
      );
    },

    async listUsers() {
      // User-role items are keyed by (tenant, user, organization); there is no
      // index by role, so listing a role's users would require a full scan or
      // a new GSI. Throw so the gap is obvious rather than silently returning
      // empty results, mirroring the actions adapters.
      throw new Error(
        "userRoles.listUsers is not implemented in the AWS DynamoDB adapter. " +
          "Use a SQL-backed adapter (kysely/drizzle) for tenants that need to list a role's users.",
      );
    },

    async list(
      tenantId: string,
      userId: string,
      _params: ListParams = {},
      organizationId?: string,
    ): Promise<Role[]> {
      const { items } = await queryItems<UserRoleItem>(
        ctx,
        userRoleKeys.pk(tenantId, userId, organizationId),
        { skPrefix: userRoleKeys.skPrefix() },
      );

      // Fetch the actual role details
      const roles: Role[] = [];
      for (const userRole of items) {
        const roleItem = await getItem<RoleItem>(
          ctx,
          roleKeys.pk(tenantId),
          roleKeys.sk(userRole.role_id),
        );
        if (roleItem) {
          roles.push(toRole(roleItem));
        }
      }

      return roles;
    },

    // Ordered by the sort key, USER_ROLE#<role id>, within one partition. User
    // roles are partitioned by organization, so (as with `list`) only the
    // partition for `organizationId` is read: omitted or empty means the global
    // partition. A page can come back shorter than `take` when an assignment
    // points at a role that no longer exists. `take` is defaulted so a bare
    // call still runs in keyset mode.
    async listCheckpoint(
      tenantId: string,
      userId: string,
      params: ListParams = {},
      organizationId?: string,
    ): Promise<ListUserRolesCheckpointResponse> {
      const result = await queryWithPagination<UserRoleItem>(
        ctx,
        userRoleKeys.pk(tenantId, userId, organizationId),
        { from: params.from, take: params.take ?? 50 },
        { skPrefix: userRoleKeys.skPrefix() },
      );

      const roles: Role[] = [];
      for (const userRole of result.items) {
        const roleItem = await getItem<RoleItem>(
          ctx,
          roleKeys.pk(tenantId),
          roleKeys.sk(userRole.role_id),
        );
        if (roleItem) {
          roles.push(toRole(roleItem));
        }
      }

      return { roles, next: result.next };
    },
  };
}
