import { DataAdapters, LogTypes } from "authhero";
import { ShadowDiff, compareShadow, sha256 } from "./shadow";

/**
 * Options for config inheritance shadow mode. Shadow mode compares the parent
 * chain resolver with read-time inheritance and logs differences; it never
 * changes what a request sees.
 */
export interface InheritanceShadowOptions {
  /** Fraction of reads (0..1) that may start a comparison. @default 1 */
  sample?: number;
  /** Minimum time between comparisons of the same tenant. @default 60000 */
  intervalMs?: number;
  /** Also log differences that are expected (inherited rows the tenant lacks). @default false */
  includeExpected?: boolean;
}

const DEDUPE_TTL_MS = 60 * 60 * 1000;
const DEDUPE_MAX = 10_000;

export interface ShadowReporter {
  /** Starts a comparison for `tenantId` in the background, if due. */
  schedule(tenantId: string, legacyControlPlane: string | undefined): void;
}

export function createShadowReporter(
  adapters: DataAdapters,
  options: InheritanceShadowOptions,
): ShadowReporter {
  const sample = options.sample ?? 1;
  const intervalMs = options.intervalMs ?? 60_000;
  const lastRun = new Map<string, number>();
  const running = new Set<string>();
  const logged = new Map<string, number>();

  async function run(tenantId: string, legacyControlPlane?: string) {
    const diffs = await compareShadow({
      adapters,
      tenantId,
      legacyControlPlane,
    });
    const now = Date.now();
    if (logged.size > DEDUPE_MAX) logged.clear();

    for (const diff of diffs) {
      if (diff.expected && !options.includeExpected) continue;
      const id = await sha256(
        [
          tenantId,
          diff.entity,
          diff.key,
          diff.kind,
          diff.fields.join(","),
        ].join("|"),
      );
      const seen = logged.get(id);
      if (seen !== undefined && now - seen < DEDUPE_TTL_MS) continue;
      logged.set(id, now);
      await writeDiff(adapters, tenantId, diff, legacyControlPlane);
    }
  }

  return {
    schedule(tenantId, legacyControlPlane) {
      if (running.has(tenantId)) return;
      if (sample < 1 && Math.random() >= sample) return;
      const now = Date.now();
      const last = lastRun.get(tenantId);
      if (last !== undefined && now - last < intervalMs) return;
      lastRun.set(tenantId, now);
      running.add(tenantId);
      // Shadow mode must never affect the request: swallow every failure.
      run(tenantId, legacyControlPlane)
        .catch(() => {})
        .finally(() => running.delete(tenantId));
    },
  };
}

async function writeDiff(
  adapters: DataAdapters,
  tenantId: string,
  diff: ShadowDiff,
  legacyControlPlane: string | undefined,
) {
  await adapters.logs.create(tenantId, {
    type: LogTypes.CONFIG_INHERITANCE_DIFF,
    date: new Date().toISOString(),
    isMobile: false,
    description: `${diff.kind} ${diff.entity} ${diff.key}`,
    details: {
      shadow: "config-inheritance",
      legacy_control_plane: legacyControlPlane,
      ...diff,
    },
  });
}
