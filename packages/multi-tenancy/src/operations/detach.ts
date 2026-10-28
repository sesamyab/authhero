import {
  DataAdapters,
  TenantOperation,
  actionInsertSchema,
  connectionInsertSchema,
  fetchAll,
  hookCodeInsertSchema,
  hookInsertSchema,
  isSyncedRowId,
  resourceServerInsertSchema,
} from "authhero";
import { readConfigRows } from "../inheritance/read";
import type { OperationRecorder } from "./recorder";

/**
 * `detach`: a synced tenant leaves its parent (docs/design/tenant-config-
 * inheritance.md, open question 1). The copies a sync delivered (`sy` ids) are
 * either turned into the tenant's own rows (a snapshot: the content is kept,
 * the ids are normal, and `scope`, `override` and `enforce` are dropped, so
 * nothing locks them), or with `clean` removed. The tenant row then gets
 * `config_sync: "detached"` and no parent, so nothing inherits or syncs into it
 * again.
 *
 * Platform rows (`scope: "platform"`) run for the tenant but are hidden from
 * its admins, so converting them would expose code and secrets. They are kept
 * as copies and reported; only `clean` removes them.
 */

export type DetachEntity =
  | "connection"
  | "resourceServer"
  | "hookCode"
  | "action"
  | "hook";

export interface DetachOptions {
  /** Report what would happen; write nothing. */
  dryRun: boolean;
  /** Remove the copies instead of turning them into the tenant's own rows. */
  clean: boolean;
}

export interface DetachEntityOutcome {
  converted: number;
  removed: number;
  skipped: number;
  errors: string[];
}

export interface DetachRow {
  entity: DetachEntity;
  key: string;
  /** `kept`: a platform row that stays as a copy (or code it runs). */
  action: "converted" | "removed" | "kept";
}

export interface DetachResult {
  status: "detached" | "dry-run" | "already-detached" | "partial";
  /** `convert|remove|skip <entity>:<key>` for every row looked at. */
  changes: string[];
  /** The same rows, structured. */
  rows: DetachRow[];
  entities: Record<DetachEntity, DetachEntityOutcome>;
}

export type DetachConfigFn = (
  tenantId: string,
  options: DetachOptions,
) => Promise<DetachResult>;

/** Reads the operation's `input` (fixed at creation, never secrets). */
export function detachOptionsOf(
  operation: Pick<TenantOperation, "input">,
): DetachOptions {
  const input = (operation.input ?? {}) as Record<string, unknown>;
  return { dryRun: input.dry_run === true, clean: input.clean === true };
}

const MAX_ERROR_MESSAGES = 20;
const MAX_ERROR_MESSAGE_LENGTH = 300;

/** Every per-entity error message the detach reported. */
export function detachErrors(result: DetachResult): string[] {
  return Object.entries(result.entities).flatMap(([entity, o]) =>
    o.errors.map((message) => `${entity} ${message}`),
  );
}

/** The JSON-serialisable outcome stored in the operation's `result`. */
export function summarizeDetachResult(
  result: DetachResult,
  options: DetachOptions,
): Record<string, unknown> {
  return {
    dry_run: options.dryRun,
    clean: options.clean,
    status: result.status,
    changes: result.changes,
    rows: result.rows ?? [],
    error_messages: detachErrors(result)
      .slice(0, MAX_ERROR_MESSAGES)
      .map((message) => message.slice(0, MAX_ERROR_MESSAGE_LENGTH)),
    entities: Object.fromEntries(
      Object.entries(result.entities).map(([entity, o]) => [
        entity,
        {
          converted: o.converted,
          removed: o.removed,
          skipped: o.skipped,
          errors: o.errors.length,
        },
      ]),
    ),
  };
}

/** The step the executors run: detach, record the outcome, fail on errors. */
export async function runDetachStep(params: {
  operation: Pick<TenantOperation, "id" | "tenant_id" | "input">;
  detachTenant: DetachConfigFn;
  recorder: Pick<OperationRecorder, "setResult">;
}): Promise<Record<string, unknown>> {
  const { operation, detachTenant, recorder } = params;
  if (!operation.tenant_id) {
    throw new Error("detach operations require a tenant_id");
  }

  const options = detachOptionsOf(operation);
  const result = await detachTenant(operation.tenant_id, options);
  const summary = summarizeDetachResult(result, options);
  await recorder.setResult(operation.id, summary);

  const errors = detachErrors(result);
  if (errors.length > 0) {
    const shown = errors.slice(0, 3).join("; ");
    throw new Error(
      `detach reported ${errors.length} error(s): ${shown}${
        errors.length > 3 ? "; ..." : ""
      }`,
    );
  }
  return summary;
}

const emptyOutcome = (): DetachEntityOutcome => ({
  converted: 0,
  removed: 0,
  skipped: 0,
  errors: [],
});

type PublishingFields = {
  scope?: unknown;
  override?: unknown;
  enforce?: unknown;
};

/** A copy of `row` for the tenant to own: no id, and nothing that locks it. */
function ownCopy<T extends object>(row: T): T {
  const {
    id: _id,
    hook_id: _hookId,
    scope: _scope,
    override: _override,
    enforce: _enforce,
    ...rest
  } = row as T & { id?: string; hook_id?: string } & PublishingFields;
  return rest as unknown as T;
}

/**
 * Detaches `tenantId` from its parent in the database `adapters` reads and
 * writes, which should be the raw layer so secrets are copied as stored
 * (ciphertext). Rows are created before the copies they replace are removed.
 */
export function createInProcessDetach(adapters: DataAdapters): DetachConfigFn {
  return async (tenantId, options) => {
    const tenant = await adapters.tenants.get(tenantId);
    if (!tenant) throw new Error(`Tenant "${tenantId}" not found`);
    if (tenant.deployment_type === "wfp") {
      throw new Error(
        `Tenant "${tenantId}" has its own database: configure a dispatch detach for it`,
      );
    }

    const result: DetachResult = {
      status: options.dryRun ? "dry-run" : "detached",
      changes: [],
      rows: [],
      entities: {
        connection: emptyOutcome(),
        resourceServer: emptyOutcome(),
        hookCode: emptyOutcome(),
        action: emptyOutcome(),
        hook: emptyOutcome(),
      },
    };
    if (tenant.config_sync === "detached") {
      return { ...result, status: "already-detached" };
    }
    // Detaching keeps what the tenant holds, so the inherited config has to be
    // in its database. A tenant that inherits on read has none of it there, and
    // would lose it silently.
    if (tenant.config_sync !== "synced") {
      throw new Error(
        `Tenant "${tenantId}" is not synced: sync its parent's config into it (config_sync "synced") before detaching, otherwise it would lose what it inherits`,
      );
    }

    const { dryRun, clean } = options;
    const rows = await readConfigRows(adapters, tenantId);
    const copies = {
      connection: rows.connections.filter((r) => isSyncedRowId(r.id)),
      resourceServer: rows.resourceServers.filter((r) => isSyncedRowId(r.id)),
      hookCode: rows.hookCode.filter((r) => isSyncedRowId(r.id)),
      action: rows.actions.filter((r) => isSyncedRowId(r.id)),
      hook: rows.hooks.filter((r) => isSyncedRowId(r.hook_id)),
    };
    const isPlatform = (row: PublishingFields) => row.scope === "platform";

    // Code that a platform hook or action runs stays with them.
    const platformCode = new Set<string>();
    for (const hook of copies.hook) {
      const codeId = (hook as { code_id?: string }).code_id;
      if (isPlatform(hook) && codeId) platformCode.add(codeId);
    }
    for (const action of copies.action) {
      if (isPlatform(action)) platformCode.add(action.id);
    }

    const note = (
      entity: DetachEntity,
      verb: "convert" | "remove" | "skip",
      key: string,
      why = "",
    ) => {
      result.changes.push(`${verb} ${entity}:${key}${why}`);
      result.rows.push({
        entity,
        key,
        action:
          verb === "convert"
            ? "converted"
            : verb === "remove"
              ? "removed"
              : "kept",
      });
    };

    const attempt = async (
      entity: DetachEntity,
      key: string,
      work: () => Promise<void>,
    ) => {
      try {
        await work();
      } catch (error) {
        result.entities[entity].errors.push(
          `${key}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };

    const skipPlatform = (entity: DetachEntity, key: string) => {
      result.entities[entity].skipped += 1;
      note(entity, "skip", key, " (platform: stays a copy)");
    };

    // Removal order: hooks before the code they point at, then the rest.
    const removeOld: Array<() => Promise<void>> = [];

    if (clean) {
      // Remove every copy, including platform rows.
      const connectionLinks = async (connectionId: string) => {
        for (const clientId of await adapters.clientConnections.listByConnection(
          tenantId,
          connectionId,
        )) {
          await adapters.clientConnections.removeClientFromConnection(
            tenantId,
            connectionId,
            clientId,
          );
        }
      };
      const removals: Array<[DetachEntity, string, () => Promise<unknown>]> = [
        ...copies.hook.map(
          (r): [DetachEntity, string, () => Promise<unknown>] => [
            "hook",
            r.hook_id!,
            () => adapters.hooks.remove(tenantId, r.hook_id!),
          ],
        ),
        ...copies.action.map(
          (r): [DetachEntity, string, () => Promise<unknown>] => [
            "action",
            r.name,
            () => adapters.actions.remove(tenantId, r.id),
          ],
        ),
        ...copies.hookCode.map(
          (r): [DetachEntity, string, () => Promise<unknown>] => [
            "hookCode",
            r.id,
            () => adapters.hookCode.remove(tenantId, r.id),
          ],
        ),
        ...copies.connection.map(
          (r): [DetachEntity, string, () => Promise<unknown>] => [
            "connection",
            `${r.strategy}:${r.name}`,
            async () => {
              await connectionLinks(r.id!);
              await adapters.connections.remove(tenantId, r.id!);
            },
          ],
        ),
        ...copies.resourceServer.map(
          (r): [DetachEntity, string, () => Promise<unknown>] => [
            "resourceServer",
            r.identifier,
            () => adapters.resourceServers.remove(tenantId, r.id!),
          ],
        ),
      ];
      for (const [entity, key, remove] of removals) {
        note(entity, "remove", key);
        await attempt(entity, key, async () => {
          if (!dryRun) await remove();
          result.entities[entity].removed += 1;
        });
      }
    } else {
      const newCodeIds = new Map<string, string>();
      // Code that is, or in a dry run would be, converted: what a hook needs
      // to be converted too. Platform code is never in it.
      const plannedCode = new Set<string>();

      for (const row of copies.hookCode) {
        if (platformCode.has(row.id)) {
          skipPlatform("hookCode", row.id);
          continue;
        }
        note("hookCode", "convert", row.id);
        plannedCode.add(row.id);
        await attempt("hookCode", row.id, async () => {
          if (!dryRun) {
            const created = await adapters.hookCode.create(
              tenantId,
              hookCodeInsertSchema.parse(ownCopy(row)),
            );
            newCodeIds.set(row.id, created.id);
            removeOld.push(async () => {
              await adapters.hookCode.remove(tenantId, row.id);
            });
          }
          result.entities.hookCode.converted += 1;
        });
      }

      for (const row of copies.action) {
        if (isPlatform(row)) {
          skipPlatform("action", row.name);
          continue;
        }
        note("action", "convert", row.name);
        plannedCode.add(row.id);
        await attempt("action", row.name, async () => {
          if (!dryRun) {
            const created = await adapters.actions.create(
              tenantId,
              actionInsertSchema.parse(ownCopy(row)),
            );
            newCodeIds.set(row.id, created.id);
            removeOld.push(async () => {
              await adapters.actions.remove(tenantId, row.id);
            });
          }
          result.entities.action.converted += 1;
        });
      }

      const organizations = dryRun
        ? []
        : await fetchAll<{ id: string }>(
            (params) => adapters.organizations.list(tenantId, params),
            "organizations",
            { cursorField: "id", pageSize: 100 },
          );
      for (const row of copies.connection) {
        const key = `${row.strategy}:${row.name}`;
        if (isPlatform(row)) {
          skipPlatform("connection", key);
          continue;
        }
        note("connection", "convert", key);
        await attempt("connection", key, async () => {
          if (!dryRun) {
            const { enabled_clients: _enabled, ...rest } = ownCopy(row);
            const created = await adapters.connections.create(
              tenantId,
              connectionInsertSchema.parse(rest),
            );
            // The tenant's clients and organizations that used the copy use
            // the new row.
            for (const clientId of await adapters.clientConnections.listByConnection(
              tenantId,
              row.id!,
            )) {
              await adapters.clientConnections.addClientToConnection(
                tenantId,
                created.id!,
                clientId,
              );
              await adapters.clientConnections.removeClientFromConnection(
                tenantId,
                row.id!,
                clientId,
              );
            }
            for (const org of organizations) {
              const links = await adapters.organizationConnections.list(
                tenantId,
                org.id,
              );
              const link = links.find((l) => l.connection_id === row.id);
              if (!link) continue;
              const {
                connection_id: _c,
                organization_id: _o,
                ...linkRest
              } = link as typeof link & { organization_id?: string };
              await adapters.organizationConnections.create(tenantId, org.id, {
                ...linkRest,
                connection_id: created.id!,
              } as never);
              await adapters.organizationConnections.remove(
                tenantId,
                org.id,
                row.id!,
              );
            }
            removeOld.push(async () => {
              await adapters.connections.remove(tenantId, row.id!);
            });
          }
          result.entities.connection.converted += 1;
        });
      }

      for (const row of copies.resourceServer) {
        if (isPlatform(row)) {
          skipPlatform("resourceServer", row.identifier);
          continue;
        }
        note("resourceServer", "convert", row.identifier);
        await attempt("resourceServer", row.identifier, async () => {
          if (!dryRun) {
            // The identifier is unique per tenant, so the copy goes first and
            // is put back if the new row cannot be created.
            await adapters.resourceServers.remove(tenantId, row.id!);
            try {
              await adapters.resourceServers.create(
                tenantId,
                resourceServerInsertSchema.parse(ownCopy(row)),
              );
            } catch (error) {
              await adapters.resourceServers.create(
                tenantId,
                resourceServerInsertSchema.parse(row),
              );
              throw error;
            }
          }
          result.entities.resourceServer.converted += 1;
        });
      }

      const hookRemovals: Array<() => Promise<void>> = [];
      for (const row of copies.hook) {
        const key = row.hook_id!;
        const codeId = (row as { code_id?: string }).code_id;
        if (isPlatform(row)) {
          skipPlatform("hook", key);
          continue;
        }
        if (
          codeId &&
          !(dryRun ? plannedCode.has(codeId) : newCodeIds.has(codeId))
        ) {
          result.entities.hook.skipped += 1;
          note("hook", "skip", key, " (its code is not converted)");
          continue;
        }
        note("hook", "convert", key);
        await attempt("hook", key, async () => {
          if (!dryRun) {
            await adapters.hooks.create(
              tenantId,
              hookInsertSchema.parse({
                ...ownCopy(row),
                ...(codeId ? { code_id: newCodeIds.get(codeId) } : {}),
              }),
            );
            hookRemovals.push(async () => {
              await adapters.hooks.remove(tenantId, key);
            });
          }
          result.entities.hook.converted += 1;
        });
      }
      // Hooks go first: they point at the code that is removed after them.
      removeOld.unshift(...hookRemovals);
    }

    const failed = Object.values(result.entities).some(
      (o) => o.errors.length > 0,
    );
    if (failed) return { ...result, status: "partial" };
    if (dryRun) return result;

    for (const remove of removeOld) {
      try {
        await remove();
      } catch (error) {
        result.entities.hook.errors.push(
          `remove: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (Object.values(result.entities).some((o) => o.errors.length > 0)) {
      return { ...result, status: "partial" };
    }

    await adapters.tenants.update(tenantId, {
      parent_tenant_id: null,
      config_sync: "detached",
      config_sync_hash: null,
      config_synced_at: null,
    });
    return result;
  };
}
