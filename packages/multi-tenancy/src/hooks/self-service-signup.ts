import { MANAGEMENT_API_AUDIENCE } from "authhero";
import type { DataAdapters, Hooks } from "authhero";

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
  const find = async () =>
    (await data.roles.list(controlPlaneTenantId, {})).roles.find(
      (role) => role.name === roleName,
    );

  let role = await find();
  if (!role) {
    try {
      role = await data.roles.create(controlPlaneTenantId, {
        name: roleName,
        description:
          "Can create tenants. Granted to verified self-service sign-ups.",
      });
    } catch (error) {
      // A concurrent sign-up may have created it first.
      role = await find();
      if (!role) throw error;
    }
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
      // "" selects the global (tenant-level) roles.
      const held = await data.userRoles.list(
        controlPlaneTenantId,
        userId,
        undefined,
        "",
      );
      if (held.some((role) => role.name === roleName)) return;

      const roleId = await ensureSelfServiceRole(
        data,
        controlPlaneTenantId,
        roleName,
      );
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
