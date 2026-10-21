import type { DataAdapters } from "authhero";
import { resolveTenantChain } from "./chain";
import { computeLegacyConfig } from "./legacy";
import { mergeConfig } from "./merge";
import { readConfigRows } from "./read";
import { ConfigEntity, ConfigRows } from "./types";

export interface ShadowDiff {
  entity: ConfigEntity;
  key: string;
  kind: "missing" | "extra" | "changed";
  /** Top-level fields that differ (`changed` only). Values are never logged. */
  fields: string[];
  /**
   * The new model materialises inherited rows into the tenant, where
   * read-time inheritance only overlays rows the tenant already has. A row
   * that is `extra` for that reason is expected and not a bug.
   */
  expected: boolean;
  legacy_hash?: string;
  new_hash?: string;
}

const SECRET_KEY = /secret|password|private_key|api_key|token/i;
// Publishing metadata and identity are not part of the effective config.
const IGNORED = new Set([
  "id",
  "tenant_id",
  "created_at",
  "updated_at",
  "scope",
  "override",
  "enforce",
  // Virtual, join-table backed; not part of a connection's own config.
  "enabled_clients",
]);

export async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/** Stable JSON with secret values replaced by their hash. */
async function normalize(value: unknown, parentKey = ""): Promise<unknown> {
  if (Array.isArray(value)) {
    if (parentKey === "secrets") {
      // Action secrets are `{ name, value }` pairs.
      const out: Record<string, unknown> = {};
      for (const item of value as Array<{ name: string; value?: string }>) {
        out[item.name] =
          item.value === undefined
            ? null
            : `sha256:${await sha256(item.value)}`;
      }
      return out;
    }
    return Promise.all(value.map((v) => normalize(v, parentKey)));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined || v === null) continue;
      out[key] =
        typeof v === "string" && SECRET_KEY.test(key)
          ? `sha256:${await sha256(v)}`
          : await normalize(v, key);
    }
    return out;
  }
  return value;
}

async function view(row: unknown): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    if (!IGNORED.has(k)) out[k] = v;
  }
  return (await normalize(out)) as Record<string, unknown>;
}

const KEYS: Record<
  Exclude<ConfigEntity, "emailProvider" | "branding" | "promptSettings">,
  (row: any) => string
> = {
  connection: (r) => r.strategy,
  resourceServer: (r) => r.identifier,
  hook: (r) => r.hook_id,
  action: (r) => r.name,
};

// Entities where read-time inheritance only overlays rows the tenant owns.
const MATERIALISED = new Set<ConfigEntity>([
  "connection",
  "resourceServer",
  "action",
  "emailProvider",
  "branding",
  "promptSettings",
]);

async function indexRows(rows: ConfigRows) {
  const index = new Map<ConfigEntity, Map<string, Record<string, unknown>>>();
  const put = async (entity: ConfigEntity, key: string, row: unknown) => {
    const map = index.get(entity) ?? new Map();
    map.set(key, await view(row));
    index.set(entity, map);
  };
  for (const [entity, keyOf] of Object.entries(KEYS)) {
    const list = rows[
      (
        {
          connection: "connections",
          resourceServer: "resourceServers",
          hook: "hooks",
          action: "actions",
        } as const
      )[entity as keyof typeof KEYS]
    ] as unknown[];
    for (const row of list) await put(entity as ConfigEntity, keyOf(row), row);
  }
  for (const entity of [
    "emailProvider",
    "branding",
    "promptSettings",
  ] as const) {
    if (rows[entity]) await put(entity, "singleton", rows[entity]);
  }
  return index;
}

export async function diffConfig(
  legacy: ConfigRows,
  next: ConfigRows,
): Promise<ShadowDiff[]> {
  const [a, b] = await Promise.all([indexRows(legacy), indexRows(next)]);
  const diffs: ShadowDiff[] = [];
  const entities = new Set([...a.keys(), ...b.keys()]);

  for (const entity of entities) {
    const left = a.get(entity) ?? new Map();
    const right = b.get(entity) ?? new Map();
    for (const key of new Set([...left.keys(), ...right.keys()])) {
      const l = left.get(key);
      const r = right.get(key);
      if (l && !r) {
        diffs.push({
          entity,
          key,
          kind: "missing",
          fields: [],
          expected: false,
        });
      } else if (!l && r) {
        diffs.push({
          entity,
          key,
          kind: "extra",
          fields: [],
          expected: MATERIALISED.has(entity),
        });
      } else if (l && r) {
        const lj = JSON.stringify(l);
        const rj = JSON.stringify(r);
        if (lj === rj) continue;
        const fields = [...new Set([...Object.keys(l), ...Object.keys(r)])]
          .filter((f) => JSON.stringify(l[f]) !== JSON.stringify(r[f]))
          .sort();
        diffs.push({
          entity,
          key,
          kind: "changed",
          fields,
          expected: false,
          legacy_hash: await sha256(lj),
          new_hash: await sha256(rj),
        });
      }
    }
  }
  return diffs;
}

/**
 * Computes the new resolver's result and the legacy result for a tenant and
 * returns their differences. Reads only; the resolver result is never used.
 */
export async function compareShadow(params: {
  adapters: DataAdapters;
  tenantId: string;
  legacyControlPlane?: string;
  maxDepth?: number;
}): Promise<ShadowDiff[]> {
  const { adapters, tenantId, legacyControlPlane } = params;
  const chain = await resolveTenantChain({
    tenantId,
    getTenant: (id) => adapters.tenants.get(id),
    legacyControlPlane,
    maxDepth: params.maxDepth,
  });

  const tenantRows = await readConfigRows(adapters, tenantId);
  const chainRows = await Promise.all(
    chain.map((id) => readConfigRows(adapters, id)),
  );
  const legacyRows =
    legacyControlPlane && legacyControlPlane !== tenantId
      ? await readConfigRows(adapters, legacyControlPlane)
      : undefined;

  const { hidden: _hidden, ...resolved } = mergeConfig(chainRows, tenantRows);
  return diffConfig(computeLegacyConfig(tenantRows, legacyRows), resolved);
}
