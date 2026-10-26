import { HTTPException } from "hono/http-exception";
import {
  Action,
  ActionVersionsAdapter,
  ActionsAdapter,
  ClientConnectionsAdapter,
  Connection,
  ConnectionsAdapter,
  DataAdapters,
  EmailProvidersAdapter,
  Hook,
  HookCodeAdapter,
  HooksAdapter,
  OrganizationConnectionsAdapter,
  ResourceServer,
  ResourceServersAdapter,
  ActionExecutionsAdapter,
} from "@authhero/adapter-interfaces";
import { isSyncedRowId } from "./synced-rows";
import { fetchAll } from "../utils/fetchAll";

/**
 * Hides `scope: "platform"` rows that a config sync delivered into a tenant
 * from that tenant's own management API. Such rows must run (the code-hook
 * executor reads them through other adapters) but their code and secrets are
 * never shown, listed, edited or referenced by the tenant's admins.
 *
 * A row is hidden when it is platform-scoped **and** has a synced id. The
 * control plane's own origin rows are platform-scoped too, but they are
 * owned by the tenant that publishes them and stay visible there. Operators
 * (control-plane credentials) see everything.
 *
 * A hidden row behaves as if it did not exist: `get` returns `null`, lists omit
 * it, and writes against it are refused as not found. List totals and
 * checkpoint cursors are not adjusted for hidden rows.
 *
 * Limit: this protects against the tenant's management API. The code and
 * (encrypted) secrets are still stored in the tenant's database, so anyone
 * with access to the database or the worker environment can read them.
 */

export interface PlatformRowsOptions {
  /** The tenant whose management API is being served. */
  tenantId: string;
  /** Control-plane credentials see platform rows. */
  isOperator: boolean;
}

type Idd = { id?: string | null; scope?: string | null };

const isHidden = (row: Idd | null | undefined): boolean =>
  !!row && row.scope === "platform" && isSyncedRowId(row.id);

const isHiddenHook = (hook: Hook | null | undefined): boolean =>
  !!hook &&
  (hook as { scope?: string | null }).scope === "platform" &&
  isSyncedRowId((hook as { hook_id?: string }).hook_id);

const notFound = (what: string) =>
  new HTTPException(404, { message: `${what} not found` });

export function withPlatformRowsHidden(
  data: DataAdapters,
  options: PlatformRowsOptions,
): DataAdapters {
  if (options.isOperator) return data;
  const { tenantId } = options;

  // Per-wrapper (so per-request) memo of the ids to hide.
  let hiddenActions: Promise<Action[]> | undefined;
  let hiddenConnectionIds: Promise<Set<string>> | undefined;

  const platformActions = () =>
    (hiddenActions ??= fetchAll<Action>(
      (params) => data.actions.list(tenantId, params),
      "actions",
      { cursorField: "id" },
    ).then((all) => all.filter(isHidden)));

  const platformConnectionIds = () =>
    (hiddenConnectionIds ??= fetchAll<Connection>(
      (params) => data.connections.list(tenantId, params),
      "connections",
      { cursorField: "id" },
    ).then((all) => new Set(all.filter(isHidden).map((c) => c.id as string))));

  /** Whether a hook or action `code_id` points at a hidden row. */
  const codeIsHidden = async (codeId: string): Promise<boolean> => {
    const action = await data.actions.get(tenantId, codeId);
    if (isHidden(action)) return true;
    const hooks = await fetchAll<Hook>(
      (params) => data.hooks.list(tenantId, params),
      "hooks",
      { cursorField: "hook_id", q: `code_id:${codeId}` },
    );
    return hooks.some(isHiddenHook);
  };

  const actions: ActionsAdapter = {
    create: data.actions.create,
    get: async (tid, id) => {
      const row = await data.actions.get(tid, id);
      return isHidden(row) ? null : row;
    },
    list: async (tid, params) => {
      const result = await data.actions.list(tid, params);
      return {
        ...result,
        actions: result.actions.filter((a) => !isHidden(a)),
      };
    },
    update: async (tid, id, action) => {
      if (isHidden(await data.actions.get(tid, id))) return false;
      return data.actions.update(tid, id, action);
    },
    remove: async (tid, id) => {
      if (isHidden(await data.actions.get(tid, id))) return false;
      return data.actions.remove(tid, id);
    },
  };

  const actionVersions: ActionVersionsAdapter = {
    create: async (tid, version, opts) => {
      if (isHidden(await data.actions.get(tid, version.action_id))) {
        throw notFound("Action");
      }
      return data.actionVersions.create(tid, version, opts);
    },
    get: async (tid, actionId, versionId) =>
      isHidden(await data.actions.get(tid, actionId))
        ? null
        : data.actionVersions.get(tid, actionId, versionId),
    list: async (tid, actionId, params) =>
      isHidden(await data.actions.get(tid, actionId))
        ? { versions: [], start: 0, limit: params?.per_page ?? 50, length: 0 }
        : data.actionVersions.list(tid, actionId, params),
    removeForAction: async (tid, actionId) =>
      isHidden(await data.actions.get(tid, actionId))
        ? 0
        : data.actionVersions.removeForAction(tid, actionId),
  };

  const actionExecutions: ActionExecutionsAdapter = {
    ...data.actionExecutions,
    get: async (tid, id) => {
      const execution = await data.actionExecutions.get(tid, id);
      if (!execution) return execution;
      const names = new Set((await platformActions()).map((a) => a.name));
      return execution.results?.some((r) => names.has(r.action_name))
        ? null
        : execution;
    },
  };

  const hooks: HooksAdapter = {
    ...data.hooks,
    create: async (tid, hook, opts) => {
      const codeId = (hook as { code_id?: string }).code_id;
      if (codeId && (await codeIsHidden(codeId))) throw notFound("Code");
      return data.hooks.create(tid, hook, opts);
    },
    get: async (tid, id) => {
      const row = await data.hooks.get(tid, id);
      return isHiddenHook(row) ? null : row;
    },
    list: async (tid, params) => {
      const result = await data.hooks.list(tid, params);
      return { ...result, hooks: result.hooks.filter((h) => !isHiddenHook(h)) };
    },
    update: async (tid, id, hook) => {
      if (isHiddenHook(await data.hooks.get(tid, id))) return false;
      const codeId = (hook as { code_id?: string }).code_id;
      if (codeId && (await codeIsHidden(codeId))) throw notFound("Code");
      return data.hooks.update(tid, id, hook);
    },
    remove: async (tid, id) => {
      if (isHiddenHook(await data.hooks.get(tid, id))) return false;
      return data.hooks.remove(tid, id);
    },
  };

  const hookCode: HookCodeAdapter = {
    create: data.hookCode.create,
    get: async (tid, id) =>
      (await codeIsHidden(id)) ? null : data.hookCode.get(tid, id),
    update: async (tid, id, code) =>
      (await codeIsHidden(id)) ? false : data.hookCode.update(tid, id, code),
    remove: async (tid, id) =>
      (await codeIsHidden(id)) ? false : data.hookCode.remove(tid, id),
  };

  const connections: ConnectionsAdapter = {
    create: data.connections.create,
    get: async (tid, id) => {
      const row = await data.connections.get(tid, id);
      return isHidden(row) ? null : row;
    },
    list: async (tid, params) => {
      const result = await data.connections.list(tid, params);
      return {
        ...result,
        connections: result.connections.filter((c) => !isHidden(c)),
      };
    },
    update: async (tid, id, connection) => {
      if (isHidden(await data.connections.get(tid, id))) return false;
      return data.connections.update(tid, id, connection);
    },
    remove: async (tid, id) => {
      if (isHidden(await data.connections.get(tid, id))) return false;
      return data.connections.remove(tid, id);
    },
  };

  const clientConnections: ClientConnectionsAdapter = {
    listByClient: async (tid, clientId) =>
      (await data.clientConnections.listByClient(tid, clientId)).filter(
        (c) => !isHidden(c),
      ),
    // Replacing a client's connections must not drop the hidden ones the
    // tenant admin cannot see, nor accept ids of hidden ones.
    updateByClient: async (tid, clientId, connectionIds) => {
      const hidden = await platformConnectionIds();
      const current = await data.clientConnections.listByClient(tid, clientId);
      const keep = current
        .filter((c) => isHidden(c))
        .map((c) => c.id as string);
      return data.clientConnections.updateByClient(tid, clientId, [
        ...connectionIds.filter((id) => !hidden.has(id)),
        ...keep,
      ]);
    },
    listByConnection: async (tid, connectionId) =>
      (await platformConnectionIds()).has(connectionId)
        ? []
        : data.clientConnections.listByConnection(tid, connectionId),
    addClientToConnection: async (tid, connectionId, clientId) =>
      (await platformConnectionIds()).has(connectionId)
        ? false
        : data.clientConnections.addClientToConnection(
            tid,
            connectionId,
            clientId,
          ),
    removeClientFromConnection: async (tid, connectionId, clientId) =>
      (await platformConnectionIds()).has(connectionId)
        ? false
        : data.clientConnections.removeClientFromConnection(
            tid,
            connectionId,
            clientId,
          ),
  };

  const organizationConnections: OrganizationConnectionsAdapter = {
    ...data.organizationConnections,
    create: async (tid, orgId, params, opts) => {
      if ((await platformConnectionIds()).has(params.connection_id)) {
        throw notFound("Connection");
      }
      return data.organizationConnections.create(tid, orgId, params, opts);
    },
    list: async (tid, orgId) => {
      const hidden = await platformConnectionIds();
      return (await data.organizationConnections.list(tid, orgId)).filter(
        (c) => !hidden.has(c.connection_id),
      );
    },
    get: async (tid, orgId, connectionId) =>
      (await platformConnectionIds()).has(connectionId)
        ? null
        : data.organizationConnections.get(tid, orgId, connectionId),
    update: async (tid, orgId, connectionId, params) =>
      (await platformConnectionIds()).has(connectionId)
        ? null
        : data.organizationConnections.update(tid, orgId, connectionId, params),
    remove: async (tid, orgId, connectionId) =>
      (await platformConnectionIds()).has(connectionId)
        ? false
        : data.organizationConnections.remove(tid, orgId, connectionId),
    ...(data.organizationConnections.listCheckpoint
      ? {
          listCheckpoint: async (tid, orgId, params) => {
            const hidden = await platformConnectionIds();
            const result = await data.organizationConnections.listCheckpoint!(
              tid,
              orgId,
              params,
            );
            return {
              ...result,
              connections: result.connections.filter(
                (c) => !hidden.has(c.connection_id),
              ),
            };
          },
        }
      : {}),
  };

  const resourceServers: ResourceServersAdapter = {
    ...data.resourceServers,
    get: async (tid, id) => {
      const row = await data.resourceServers.get(tid, id);
      return isHidden(row as ResourceServer | null) ? null : row;
    },
    list: async (tid, params) => {
      const result = await data.resourceServers.list(tid, params);
      return {
        ...result,
        resource_servers: result.resource_servers.filter((r) => !isHidden(r)),
      };
    },
    update: async (tid, id, params) => {
      if (isHidden((await data.resourceServers.get(tid, id)) as Idd | null)) {
        return false;
      }
      return data.resourceServers.update(tid, id, params);
    },
    remove: async (tid, id) => {
      if (isHidden((await data.resourceServers.get(tid, id)) as Idd | null)) {
        return false;
      }
      return data.resourceServers.remove(tid, id);
    },
  };

  // The email provider is a singleton without an id, so a synced copy cannot be
  // told from the tenant's own row by id. It is hidden only for tenants that
  // receive config (they have a parent or are in `synced` mode).
  const emailProviderHidden = async (tid: string): Promise<boolean> => {
    const provider = await data.emailProviders.get(tid);
    if ((provider as { scope?: string } | null)?.scope !== "platform") {
      return false;
    }
    const tenant = await data.tenants.get(tid);
    return !!tenant?.parent_tenant_id || tenant?.config_sync === "synced";
  };
  const emailProviders: EmailProvidersAdapter = {
    ...data.emailProviders,
    get: async (tid) =>
      (await emailProviderHidden(tid)) ? null : data.emailProviders.get(tid),
    update: async (tid, provider) => {
      if (await emailProviderHidden(tid)) throw notFound("Email provider");
      return data.emailProviders.update(tid, provider);
    },
    remove: async (tid) => {
      if (await emailProviderHidden(tid)) throw notFound("Email provider");
      return data.emailProviders.remove(tid);
    },
  };

  return {
    ...data,
    actions,
    actionVersions,
    actionExecutions,
    hooks,
    hookCode,
    connections,
    clientConnections,
    organizationConnections,
    resourceServers,
    emailProviders,
  };
}
