import type { Action, Hook } from "authhero";
import {
  isInheritableHook,
  mergeConnectionWithFallback,
  mergeResourceServerWithFallback,
} from "../middleware/settings-inheritance";
import { ConfigRows } from "./types";

function secretsToMap(
  secrets: Array<{ name: string; value?: string }> | undefined,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const secret of secrets ?? []) {
    if (secret.value !== undefined) map[secret.name] = secret.value;
  }
  return map;
}

/**
 * Mirrors `loadCodeForHook` (authhero/src/hooks/codehooks.ts): an
 * `inherit: true` stub takes the code of the control plane action with the
 * same name and `is_system`, upstream secrets as the base and local secrets
 * on top. Kept in step with it by a parity test.
 */
function resolveLegacyAction(action: Action, cp: Action[]): Action {
  if (!action.inherit) return action;
  const upstream = cp.find((a) => a.name === action.name && a.is_system);
  if (!upstream) return action;
  const secrets = {
    ...secretsToMap(upstream.secrets),
    ...secretsToMap(action.secrets),
  };
  return {
    ...action,
    code: upstream.code,
    secrets: Object.entries(secrets).map(([name, value]) => ({ name, value })),
  };
}

/**
 * What read-time inheritance returns for a tenant today, computed from plain
 * rows with the very helpers the runtime fallback adapter uses.
 */
export function computeLegacyConfig(
  tenant: ConfigRows,
  controlPlane: ConfigRows | undefined,
): ConfigRows {
  if (!controlPlane) return tenant;

  const localHookIds = new Set(
    tenant.hooks.map((h) => (h as { hook_id?: string }).hook_id),
  );
  const inheritedHooks: Hook[] = controlPlane.hooks.filter(
    (h) =>
      isInheritableHook(h) &&
      !localHookIds.has((h as { hook_id?: string }).hook_id),
  );

  return {
    connections: tenant.connections.map((c) =>
      mergeConnectionWithFallback(c, controlPlane.connections),
    ),
    resourceServers: tenant.resourceServers.map((rs) =>
      rs.is_system
        ? mergeResourceServerWithFallback(
            rs,
            controlPlane.resourceServers.find((cp) => cp.id === rs.id) ?? null,
          )
        : rs,
    ),
    hooks: [...tenant.hooks, ...inheritedHooks],
    hookCode: tenant.hookCode,
    actions: tenant.actions.map((a) =>
      resolveLegacyAction(a, controlPlane.actions),
    ),
    emailProvider: tenant.emailProvider ?? controlPlane.emailProvider,
    // Branding and prompt settings are not merged at read time.
    branding: tenant.branding,
    promptSettings: tenant.promptSettings,
  };
}
