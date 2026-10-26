import type {
  Action,
  ConfigOverride,
  ConfigScope,
  Connection,
  Hook,
  HookCode,
  ResourceServer,
} from "authhero";
import {
  isInheritableHook,
  mergeResourceServerScopes,
} from "../middleware/settings-inheritance";
import {
  ConfigEntity,
  ConfigRows,
  ResolvedConfig,
  emptyConfigRows,
} from "./types";

type Publishable = {
  scope?: ConfigScope | null;
  override?: ConfigOverride | null;
  is_system?: boolean;
  metadata?: unknown;
};

/**
 * Scope of a row. An explicit `scope` wins. Unset falls back to what
 * read-time inheritance does today for that entity, so rows nobody has
 * annotated behave as before.
 */
export function effectiveScope(
  entity: ConfigEntity,
  row: Publishable,
): ConfigScope {
  if (row.scope) return row.scope;
  switch (entity) {
    case "connection":
    case "emailProvider":
      return "shared";
    case "resourceServer":
    case "action":
      return row.is_system ? "shared" : "local";
    case "hook":
      return isInheritableHook(row) ? "shared" : "local";
    default:
      return "local";
  }
}

/**
 * What a child may change on a row. Unset is "fields" because that is how the
 * legacy merge behaves: the tenant's values win.
 */
export function effectiveOverride(row: Publishable): ConfigOverride {
  return row.override ?? "fields";
}

export const SECRET_KEY = /secret|password|private_key|api_key|token/i;

function secretsOnly(
  parent: Record<string, unknown> | undefined,
  child: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged = { ...(parent ?? {}) };
  for (const [key, value] of Object.entries(child ?? {})) {
    if (SECRET_KEY.test(key)) merged[key] = value;
  }
  return merged;
}

/** `parent` is the row from the layer above; its `override` governs `child`. */
function overlayConnection(parent: Connection, child: Connection): Connection {
  switch (effectiveOverride(parent)) {
    case "none":
      return { ...parent, id: child.id };
    case "secrets":
      return {
        ...parent,
        id: child.id,
        options: secretsOnly(parent.options, child.options),
      } as Connection;
    default:
      return {
        ...parent,
        ...child,
        options: { ...(parent.options ?? {}), ...(child.options ?? {}) },
      } as Connection;
  }
}

function overlayResourceServer(
  parent: ResourceServer,
  child: ResourceServer,
): ResourceServer {
  switch (effectiveOverride(parent)) {
    case "none":
      return { ...parent, id: child.id };
    case "secrets":
      return {
        ...parent,
        id: child.id,
        signing_secret: child.signing_secret ?? parent.signing_secret,
      };
    default:
      return {
        ...child,
        scopes: mergeResourceServerScopes(child.scopes, parent.scopes),
      };
  }
}

function secretMap(
  secrets: Array<{ name: string; value?: string }> | undefined,
): Map<string, { name: string; value?: string }> {
  return new Map((secrets ?? []).map((s) => [s.name, s]));
}

/** Parent code, parent secrets as the base, child secrets layered on top. */
function overlayAction(parent: Action, child: Action): Action {
  const override = effectiveOverride(parent);
  if (override === "none") return { ...parent, id: child.id };
  const secrets = secretMap(parent.secrets);
  if (override === "secrets" || override === "fields") {
    for (const [name, secret] of secretMap(child.secrets)) {
      secrets.set(name, secret);
    }
  }
  const base = override === "fields" && !child.inherit ? child : parent;
  return { ...base, id: child.id, secrets: [...secrets.values()] };
}

type Layer = ConfigRows;

/**
 * Merges the config of a parent chain with the tenant's own, with no I/O.
 *
 * `chain` is the ancestors' rows **nearest first** (the same order as
 * `resolveTenantChain`); `tenant` is the tenant's own rows. Rules
 * (docs/design/tenant-config-inheritance.md, 3.3):
 * - rows merge by a stable key and the nearest layer wins, limited by the
 *   `override` of the layer above;
 * - hooks and actions add up: an ancestor's shared rows appear in addition to
 *   the tenant's own;
 * - `local` rows of an ancestor are not visible; `platform` rows are merged
 *   but listed in `hidden`.
 *
 * `enforce` does not affect the merged result yet; it constrains edits and
 * deletes, which come with the management API changes.
 */
export function mergeConfig(chain: Layer[], tenant: Layer): ResolvedConfig {
  const hidden = new Set<string>();
  // Farthest ancestor first, the tenant last.
  const layers = [...chain].reverse().concat(tenant);

  const visible = <T extends Publishable>(
    entity: ConfigEntity,
    rows: T[],
    isOwn: boolean,
    keyOf: (row: T) => string,
  ): T[] =>
    isOwn
      ? rows
      : rows.filter((row) => {
          const scope = effectiveScope(entity, row);
          if (scope === "local") return false;
          if (scope === "platform") hidden.add(`${entity}:${keyOf(row)}`);
          return true;
        });

  const out = emptyConfigRows();

  // Connections inherit by strategy, but a tenant may own several connections
  // with the same strategy, so rows are identified by strategy and name.
  const connectionKey = (c: Connection) => `${c.strategy}:${c.name}`;
  const resourceServerKey = (r: ResourceServer) => r.identifier;
  const hookKey = (h: Hook) => (h as { hook_id?: string }).hook_id ?? "";
  const actionKey = (a: Action) => a.name;

  // Ancestor connections folded by strategy: the row an own connection with
  // that strategy overlays.
  const inheritedConnections = new Map<string, Connection>();
  const ownConnections: Connection[] = [];
  let resourceServers = new Map<string, ResourceServer>();
  const hooks = new Map<string, Hook>();
  const actions = new Map<string, Action>();

  layers.forEach((layer, index) => {
    const isOwn = index === layers.length - 1;

    for (const row of visible(
      "connection",
      layer.connections,
      isOwn,
      connectionKey,
    )) {
      const below = inheritedConnections.get(row.strategy);
      if (isOwn) {
        // Every own connection is kept, as read-time inheritance does.
        ownConnections.push(below ? overlayConnection(below, row) : row);
      } else {
        inheritedConnections.set(
          row.strategy,
          below ? overlayConnection(below, row) : row,
        );
      }
    }
    for (const row of visible(
      "resourceServer",
      layer.resourceServers,
      isOwn,
      resourceServerKey,
    )) {
      const below = resourceServers.get(resourceServerKey(row));
      resourceServers.set(
        resourceServerKey(row),
        below ? overlayResourceServer(below, row) : row,
      );
    }
    for (const row of visible("hook", layer.hooks, isOwn, hookKey)) {
      hooks.set(hookKey(row), row);
    }
    for (const row of visible("action", layer.actions, isOwn, actionKey)) {
      const below = actions.get(actionKey(row));
      actions.set(actionKey(row), below ? overlayAction(below, row) : row);
    }

    for (const entity of [
      "emailProvider",
      "branding",
      "promptSettings",
    ] as const) {
      const row = layer[entity];
      if (!row) continue;
      if (isOwn || effectiveScope(entity, row) !== "local") {
        if (!isOwn && effectiveScope(entity, row) === "platform") {
          hidden.add(`${entity}:singleton`);
        }
        (out as unknown as Record<string, unknown>)[entity] = row;
      }
    }
  });

  const ownStrategies = new Set(
    layers[layers.length - 1]!.connections.map((c) => c.strategy),
  );
  out.connections = [
    ...ownConnections,
    ...[...inheritedConnections.values()].filter(
      (c) => !ownStrategies.has(c.strategy),
    ),
  ];
  out.resourceServers = [...resourceServers.values()];
  out.hooks = [...hooks.values()];
  // Code travels with the hooks that reference it: keep hook_code a visible
  // hook points at, nearest layer first.
  const referenced = new Set(
    out.hooks
      .map((h) => (h as { code_id?: string }).code_id)
      .filter((id): id is string => !!id),
  );
  const hookCode = new Map<string, HookCode>();
  for (const layer of [...layers].reverse()) {
    for (const code of layer.hookCode) {
      if (referenced.has(code.id) && !hookCode.has(code.id)) {
        hookCode.set(code.id, code);
      }
    }
  }
  out.hookCode = [...hookCode.values()];
  out.actions = [...actions.values()];
  return { ...out, hidden: [...hidden] };
}
