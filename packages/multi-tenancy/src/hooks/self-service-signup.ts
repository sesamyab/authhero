import { MANAGEMENT_API_AUDIENCE } from "authhero";
import type { DataAdapters, Hooks, Role } from "authhero";

/**
 * Name of the role that lets a user create tenants.
 */
export const DEFAULT_SELF_SERVICE_ROLE_NAME = "Tenant Creator";

/** The one permission the self-service role carries. */
export const SELF_SERVICE_PERMISSION = "create:tenants";

export interface SelfServiceSignupConfig {
  /**
   * The control plane tenant. Only users of this tenant get the role; sign-ups
   * on a child tenant never do.
   */
  controlPlaneTenantId: string;
  /**
   * Name of the global role granted to verified users.
   * @default "Tenant Creator"
   */
  roleName?: string;
}

type SelfServiceHooks = Pick<
  Hooks,
  "onExecutePostUserRegistration" | "onExecutePostUserUpdate"
>;

/**
 * Gets or creates the self-service role and makes sure it carries
 * `create:tenants` on the Management API. Other permissions an operator added
 * to the role are left alone; the role is never narrowed.
 */
async function ensureSelfServiceRole(
  data: DataAdapters,
  controlPlaneTenantId: string,
  roleName: string,
): Promise<string> {
  // Every role with the name, across all pages (adapters default to 50 a
  // page). With duplicates, the lowest id wins so concurrent callers agree.
  const find = async () => {
    const perPage = 100;
    const matches: Role[] = [];
    for (let page = 0; ; page++) {
      const { roles } = await data.roles.list(controlPlaneTenantId, {
        page,
        per_page: perPage,
      });
      matches.push(...roles.filter((role) => role.name === roleName));
      if (roles.length < perPage) break;
    }
    return matches.sort((a, b) => a.id.localeCompare(b.id))[0];
  };

  let role = await find();
  if (!role) {
    let created: Role | undefined;
    try {
      created = await data.roles.create(controlPlaneTenantId, {
        name: roleName,
        description:
          "Can create tenants. Granted to verified self-service sign-ups.",
      });
    } catch (error) {
      // A concurrent sign-up may have created it first.
      role = await find();
      if (!role) throw error;
    }
    if (created) {
      // `roles` has no unique (tenant, name), so two first sign-ups can both
      // create it. Settle on the lowest id and drop our copy if it lost.
      role = (await find()) ?? created;
      if (role.id !== created.id) {
        await data.roles.remove(controlPlaneTenantId, created.id);
      }
    }
  }
  if (!role) {
    throw new Error(`Could not find or create the "${roleName}" role`);
  }

  const permissions = await data.rolePermissions.list(
    controlPlaneTenantId,
    role.id,
    { per_page: 1000 },
  );
  const hasPermission = permissions.some(
    (permission) =>
      permission.permission_name === SELF_SERVICE_PERMISSION &&
      permission.resource_server_identifier === MANAGEMENT_API_AUDIENCE,
  );
  if (!hasPermission) {
    await data.rolePermissions.assign(controlPlaneTenantId, role.id, [
      {
        role_id: role.id,
        resource_server_identifier: MANAGEMENT_API_AUDIENCE,
        permission_name: SELF_SERVICE_PERMISSION,
      },
    ]);
  }

  return role.id;
}

/**
 * Hooks that give a user who signs up on the control plane the global
 * `Tenant Creator` role (only `create:tenants`) once their email is verified.
 *
 * - Registration: users who arrive verified (social, passwordless) get it
 *   straight away.
 * - Update: password sign-ups get it when `email_verified` turns true.
 *
 * The grant is idempotent, and a failure is logged and never breaks the
 * sign-up or the verification that triggered it.
 */
export function createSelfServiceSignupHooks(
  config: SelfServiceSignupConfig,
): SelfServiceHooks {
  const { controlPlaneTenantId } = config;
  const roleName = config.roleName ?? DEFAULT_SELF_SERVICE_ROLE_NAME;

  const grant = async (
    event: {
      ctx: { var: { data?: DataAdapters }; env: { data: DataAdapters } };
      tenant?: { id: string };
    },
    userId: string | undefined,
  ) => {
    if (event.tenant?.id !== controlPlaneTenantId || !userId) return;
    try {
      const data = event.ctx.var.data ?? event.ctx.env.data;
      // Always make sure the role carries create:tenants, also for a user
      // who already holds it, so a role that lost the permission is repaired.
      const roleId = await ensureSelfServiceRole(
        data,
        controlPlaneTenantId,
        roleName,
      );
      // "" selects the global (tenant-level) roles.
      const held = await data.userRoles.list(
        controlPlaneTenantId,
        userId,
        undefined,
        "",
      );
      if (held.some((role) => role.id === roleId)) return;

      await data.userRoles.create(controlPlaneTenantId, userId, roleId, "");
    } catch (error) {
      console.error(
        `Failed to grant the "${roleName}" role to ${userId}:`,
        error,
      );
    }
  };

  return {
    async onExecutePostUserRegistration(event) {
      if (!event.user?.email_verified) return;
      await grant(event as any, event.user.user_id);
    },
    async onExecutePostUserUpdate(event) {
      if (event.updates?.email_verified !== true) return;
      await grant(event as any, event.user_id);
    },
  };
}

/**
 * Runs the self-service hooks first, then the host's own hooks of the same
 * name, so enabling self-service does not replace what the host configured.
 */
export function chainSelfServiceHooks(
  hooks: Hooks | undefined,
  selfService: SelfServiceHooks,
): Hooks {
  return {
    ...hooks,
    async onExecutePostUserRegistration(event, api) {
      await selfService.onExecutePostUserRegistration?.(event, api);
      await hooks?.onExecutePostUserRegistration?.(event, api);
    },
    async onExecutePostUserUpdate(event, api) {
      await selfService.onExecutePostUserUpdate?.(event, api);
      await hooks?.onExecutePostUserUpdate?.(event, api);
    },
  };
}
