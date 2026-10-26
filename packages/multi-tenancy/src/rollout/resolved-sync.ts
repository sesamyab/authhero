import {
  Action,
  Branding,
  Connection,
  DataAdapters,
  EmailProvider,
  Hook,
  HookCode,
  KeyRing,
  PromptSetting,
  ResourceServer,
  actionInsertSchema,
  brandingSchema,
  canDecrypt,
  connectionInsertSchema,
  emailProviderSchema,
  hookCodeInsertSchema,
  hookInsertSchema,
  resourceServerInsertSchema,
} from "authhero";
import { resolveTenantChain } from "../inheritance/chain";
import { mergeConfig } from "../inheritance/merge";
import { readConfigRows } from "../inheritance/read";
import { emptyConfigRows } from "../inheritance/types";

/**
 * Sync of a tenant's resolved config (docs/design/tenant-config-inheritance.md,
 * section 4.1). The block is the tenant's parent chain merged with
 * `mergeConfig` and materialised under the **tenant's own id**. It carries only
 * what is inherited, never the tenant's own rows.
 *
 * Rows get deterministic ids derived from the target tenant, the entity and
 * the stable key, so a re-sync finds its rows by id and never touches a row the
 * tenant owns. Secrets are copied as stored (ciphertext).
 */

export type SyncEntity =
  | "connection"
  | "resourceServer"
  | "hook"
  | "hookCode"
  | "action";

export const SYNC_ENTITIES = [
  "connection",
  "resourceServer",
  "hookCode",
  "action",
  "hook",
] as const satisfies readonly SyncEntity[];

export interface ResolvedConfigBlock {
  version: 1;
  /** Ancestors the block was resolved from, nearest first. */
  chain: string[];
  connections: Connection[];
  resourceServers: ResourceServer[];
  hookCode: HookCode[];
  actions: Action[];
  hooks: Hook[];
  emailProvider: EmailProvider | null;
  branding: Branding | null;
  promptSettings: PromptSetting | null;
  /** `<entity>:<key>` of rows from `platform`-scoped ancestor rows. */
  hidden: string[];
  /** Explicit deletes. Only executed when the apply asks for `deletes`. */
  deletes: Array<{ entity: SyncEntity; key: string }>;
  /** Content hash of everything above; equal hash means nothing to apply. */
  hash: string;
}

export interface BuildResolvedBlockOptions {
  /** Control plane used as implicit parent for tenants without `parent_tenant_id`. */
  legacyControlPlane?: string;
  maxDepth?: number;
  deletes?: ResolvedConfigBlock["deletes"];
}

// ---------------------------------------------------------------------------
// Hashing and ids
// ---------------------------------------------------------------------------

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const ID_PREFIX: Record<SyncEntity, string> = {
  connection: "con_",
  resourceServer: "api_",
  hook: "h_",
  hookCode: "hc_",
  action: "act_",
};

/**
 * Deterministic id of a synced row: the type prefix, a `sy` marker and 15 hex
 * characters of a hash of (tenant, entity, key). 17 characters after the
 * prefix, the same shape as the ids each adapter generates.
 */
export async function syncedRowId(
  entity: SyncEntity,
  tenantId: string,
  key: string,
): Promise<string> {
  const hash = await sha256Hex(`${tenantId}|${entity}|${key}`);
  return `${ID_PREFIX[entity]}sy${hash.slice(0, 15)}`;
}

/** The stable key a row is synced by (matches `mergeConfig`). */
export function keyOf(entity: SyncEntity, row: unknown): string {
  const fields = row as Record<string, string>;
  switch (entity) {
    case "connection":
      return `${fields.strategy}:${fields.name}`;
    case "resourceServer":
      return fields.identifier!;
    case "action":
      return fields.name!;
    case "hookCode":
      return fields.id!;
    case "hook":
      return fields.hook_id!;
  }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Resolves `tenantId`'s parent chain into the block to push. Reads from
 * `adapters`, which should be the layer that returns secrets as stored
 * (ciphertext), so they are copied without being decrypted.
 */
export async function buildResolvedConfigBlock(
  adapters: DataAdapters,
  tenantId: string,
  options: BuildResolvedBlockOptions = {},
): Promise<ResolvedConfigBlock> {
  const chain = await resolveTenantChain({
    tenantId,
    getTenant: (id) => adapters.tenants.get(id),
    legacyControlPlane: options.legacyControlPlane,
    maxDepth: options.maxDepth,
  });
  const chainRows = await Promise.all(
    chain.map((id) => readConfigRows(adapters, id)),
  );

  // Ancestors only: the tenant's own rows are never part of the block.
  const merged = mergeConfig(chainRows, emptyConfigRows());

  const content = {
    version: 1 as const,
    chain,
    connections: merged.connections,
    resourceServers: merged.resourceServers,
    hookCode: merged.hookCode,
    actions: merged.actions,
    hooks: merged.hooks,
    emailProvider: merged.emailProvider,
    branding: merged.branding,
    promptSettings: merged.promptSettings,
    hidden: merged.hidden,
    deletes: options.deletes ?? [],
  };
  return { ...content, hash: await sha256Hex(canonicalJson(content)) };
}

// ---------------------------------------------------------------------------
// Key ring verification
// ---------------------------------------------------------------------------

function collectCiphertext(value: unknown, out: Set<string>) {
  if (typeof value === "string") {
    if (value.startsWith("enc:v1:")) out.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectCiphertext(item, out);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectCiphertext(item, out);
  }
}

/** Key id of a ciphertext (`enc:v1:<id>:<payload>`), `default` for untagged. */
function keyIdOf(ciphertext: string): string {
  const rest = ciphertext.slice("enc:v1:".length);
  const idx = rest.indexOf(":");
  return idx === -1 ? "default" : rest.slice(0, idx);
}

/**
 * Checks that `ring` can decrypt every ciphertext in the block. Returns the
 * key ids it cannot (never the values).
 */
export async function findUndecryptableKeyIds(
  block: ResolvedConfigBlock,
  ring: KeyRing,
): Promise<string[]> {
  const ciphertexts = new Set<string>();
  collectCiphertext(block, ciphertexts);
  const missing = new Set<string>();
  for (const value of ciphertexts) {
    if (!(await canDecrypt(value, ring))) missing.add(keyIdOf(value));
  }
  return [...missing].sort();
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface ApplyResolvedBlockOptions {
  /** Compute the diff and report it; write nothing. */
  dryRun?: boolean;
  /** Execute the block's explicit `deletes`. @default false */
  deletes?: boolean;
  /** Apply even when the stored hash equals the block hash. */
  force?: boolean;
  /**
   * The tenant's key ring. When given, the apply is refused before any write if
   * it cannot decrypt a key id the block carries.
   */
  keyRing?: KeyRing;
  /** Keep going after a failed row instead of throwing. @default true */
  continueOnError?: boolean;
}

export interface SyncEntityOutcome {
  added: number;
  changed: number;
  unchanged: number;
  deleted: number;
  errors: string[];
}

export interface ApplyResolvedBlockResult {
  status: "applied" | "up-to-date" | "dry-run";
  hash: string;
  entities: Record<
    SyncEntity | "emailProvider" | "branding" | "promptSettings",
    SyncEntityOutcome
  >;
  /** `<entity>:<key>` of rows that would be/were added, changed or deleted. */
  changes: string[];
}

const emptyOutcome = (): SyncEntityOutcome => ({
  added: 0,
  changed: 0,
  unchanged: 0,
  deleted: 0,
  errors: [],
});

const fingerprint = (value: unknown) => canonicalJson(value);

export async function applyResolvedConfigBlock(
  block: ResolvedConfigBlock,
  target: DataAdapters,
  tenantId: string,
  options: ApplyResolvedBlockOptions = {},
): Promise<ApplyResolvedBlockResult> {
  const { dryRun = false, continueOnError = true } = options;

  const result: ApplyResolvedBlockResult = {
    status: dryRun ? "dry-run" : "applied",
    hash: block.hash,
    entities: {
      connection: emptyOutcome(),
      resourceServer: emptyOutcome(),
      hookCode: emptyOutcome(),
      action: emptyOutcome(),
      hook: emptyOutcome(),
      emailProvider: emptyOutcome(),
      branding: emptyOutcome(),
      promptSettings: emptyOutcome(),
    },
    changes: [],
  };

  const tenant = await target.tenants.get(tenantId);
  // Pending deletes still need to run when the hash matches: the hash covers
  // them, but an earlier apply may have skipped them (deletes are opt-in).
  const deletesPending = !!options.deletes && block.deletes.length > 0;
  if (
    !dryRun &&
    !options.force &&
    !deletesPending &&
    tenant?.config_sync_hash === block.hash
  ) {
    return { ...result, status: "up-to-date" };
  }

  if (options.keyRing) {
    const missing = await findUndecryptableKeyIds(block, options.keyRing);
    if (missing.length > 0) {
      throw new Error(
        `Cannot sync config to '${tenantId}': its key ring cannot decrypt key id(s) ${missing
          .map((id) => `"${id}"`)
          .join(", ")} carried by the payload. Nothing was written.`,
      );
    }
  }

  const attempt = async (
    entity: keyof ApplyResolvedBlockResult["entities"],
    label: string,
    fn: () => Promise<"added" | "changed" | "unchanged">,
  ) => {
    const outcome = result.entities[entity];
    try {
      const kind = await fn();
      outcome[kind] += 1;
      if (kind !== "unchanged") result.changes.push(`${entity}:${label}`);
    } catch (error) {
      const message = `${entity} ${label}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      if (!continueOnError) throw new Error(message, { cause: error });
      outcome.errors.push(message);
    }
  };

  /** Generic upsert of a row addressed by its derived id. */
  const upsert = async <T>(params: {
    existing: T | null;
    desired: T;
    create: () => Promise<unknown>;
    update: () => Promise<unknown>;
    view: (row: T) => unknown;
  }): Promise<"added" | "changed" | "unchanged"> => {
    if (!params.existing) {
      if (!dryRun) await params.create();
      return "added";
    }
    if (
      fingerprint(params.view(params.existing)) ===
      fingerprint(params.view(params.desired))
    ) {
      return "unchanged";
    }
    if (!dryRun) await params.update();
    return "changed";
  };

  const id = (entity: SyncEntity, key: string) =>
    syncedRowId(entity, tenantId, key);

  // Source ids -> derived ids, so hooks can point at the copied code.
  const codeIds = new Map<string, string>();
  for (const code of block.hookCode) {
    codeIds.set(code.id, await id("hookCode", keyOf("hookCode", code)));
  }
  for (const action of block.actions) {
    codeIds.set(action.id, await id("action", keyOf("action", action)));
  }

  // Order matters: code before the hooks that reference it.
  for (const row of block.connections) {
    const key = keyOf("connection", row);
    const rowId = await id("connection", key);
    await attempt("connection", key, async () => {
      const { enabled_clients: _e, ...rest } = row;
      const desired = connectionInsertSchema.parse({ ...rest, id: rowId });
      const existing = await target.connections.get(tenantId, rowId);
      return upsert({
        existing: existing ? connectionInsertSchema.parse(existing) : null,
        desired,
        create: () => target.connections.create(tenantId, desired),
        update: () => target.connections.update(tenantId, rowId, desired),
        view: (r) => r,
      });
    });
  }

  for (const row of block.resourceServers) {
    const key = keyOf("resourceServer", row);
    const rowId = await id("resourceServer", key);
    await attempt("resourceServer", key, async () => {
      const desired = resourceServerInsertSchema.parse({ ...row, id: rowId });
      const existing = await target.resourceServers.get(tenantId, rowId);
      return upsert({
        existing: existing ? resourceServerInsertSchema.parse(existing) : null,
        desired,
        create: () => target.resourceServers.create(tenantId, desired),
        update: () => target.resourceServers.update(tenantId, rowId, desired),
        view: (r) => r,
      });
    });
  }

  for (const row of block.hookCode) {
    const key = keyOf("hookCode", row);
    const rowId = codeIds.get(row.id)!;
    await attempt("hookCode", key, async () => {
      const desired = hookCodeInsertSchema.parse(row);
      const found = await target.hookCode.get(tenantId, rowId);
      return upsert({
        existing: found ? hookCodeInsertSchema.parse(found) : null,
        desired,
        create: () =>
          target.hookCode.create(tenantId, desired, {
            importMetadata: { id: rowId },
          }),
        update: () => target.hookCode.update(tenantId, rowId, desired),
        view: (r) => r,
      });
    });
  }

  for (const row of block.actions) {
    const key = keyOf("action", row);
    const rowId = codeIds.get(row.id)!;
    await attempt("action", key, async () => {
      const desired = actionInsertSchema.parse(row);
      const found = await target.actions.get(tenantId, rowId);
      return upsert({
        existing: found ? actionInsertSchema.parse(found) : null,
        desired,
        create: () =>
          target.actions.create(tenantId, desired, {
            importMetadata: { id: rowId },
          }),
        update: () => target.actions.update(tenantId, rowId, desired),
        view: (r) => r,
      });
    });
  }

  for (const row of block.hooks) {
    const key = keyOf("hook", row);
    const rowId = await id("hook", key);
    await attempt("hook", key, async () => {
      const sourceCode = (row as { code_id?: string }).code_id;
      const desired = hookInsertSchema.parse({
        ...row,
        hook_id: rowId,
        ...(sourceCode
          ? { code_id: codeIds.get(sourceCode) ?? sourceCode }
          : {}),
      });
      const found = await target.hooks.get(tenantId, rowId);
      return upsert({
        existing: found ? hookInsertSchema.parse(found) : null,
        desired,
        create: () => target.hooks.create(tenantId, desired),
        update: () => target.hooks.update(tenantId, rowId, desired),
        view: (r) => r,
      });
    });
  }

  // Singletons are created only when the tenant has none of its own, so a local
  // edit is never clobbered. Later changes to the inherited row therefore do not
  // reach a tenant that already has one.
  if (block.emailProvider) {
    await attempt("emailProvider", "singleton", async () => {
      const desired = emailProviderSchema.parse(block.emailProvider);
      const existing = await target.emailProviders.get(tenantId);
      if (existing) return "unchanged";
      if (!dryRun) await target.emailProviders.create(tenantId, desired);
      return "added";
    });
  }
  if (block.branding) {
    await attempt("branding", "singleton", async () => {
      const desired = brandingSchema.parse(block.branding);
      const existing = await target.branding.get(tenantId);
      if (existing) return "unchanged";
      if (!dryRun) await target.branding.set(tenantId, desired);
      return "added";
    });
  }
  // Prompt settings are not applied: a tenant always has an effective row
  // (defaults), so there is no way to tell an untouched row from a customised
  // one without a per-row marker. Left for the management API step.

  // Explicit deletes, off by default.
  for (const entry of block.deletes) {
    const rowId = await id(entry.entity, entry.key);
    const label = `${entry.entity}:${entry.key}`;
    try {
      const exists = await rowExists(target, tenantId, entry.entity, rowId);
      if (!exists) continue;
      result.changes.push(`delete ${label}`);
      if (options.deletes && !dryRun) {
        await removeRow(target, tenantId, entry.entity, rowId);
        result.entities[entry.entity].deleted += 1;
      }
    } catch (error) {
      result.entities[entry.entity].errors.push(
        `delete ${label}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  const failed = Object.values(result.entities).some(
    (o) => o.errors.length > 0,
  );
  if (!dryRun && !failed && tenant) {
    await target.tenants.update(tenantId, {
      config_sync_hash: block.hash,
      config_synced_at: new Date().toISOString(),
    });
  }

  return result;
}

async function rowExists(
  target: DataAdapters,
  tenantId: string,
  entity: SyncEntity,
  id: string,
): Promise<boolean> {
  switch (entity) {
    case "connection":
      return !!(await target.connections.get(tenantId, id));
    case "resourceServer":
      return !!(await target.resourceServers.get(tenantId, id));
    case "hookCode":
      return !!(await target.hookCode.get(tenantId, id));
    case "action":
      return !!(await target.actions.get(tenantId, id));
    case "hook":
      return !!(await target.hooks.get(tenantId, id));
  }
}

async function removeRow(
  target: DataAdapters,
  tenantId: string,
  entity: SyncEntity,
  id: string,
): Promise<void> {
  switch (entity) {
    case "connection":
      await target.connections.remove(tenantId, id);
      return;
    case "resourceServer":
      await target.resourceServers.remove(tenantId, id);
      return;
    case "hookCode":
      await target.hookCode.remove(tenantId, id);
      return;
    case "action":
      await target.actions.remove(tenantId, id);
      return;
    case "hook":
      await target.hooks.remove(tenantId, id);
      return;
  }
}
