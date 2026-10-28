import { Badge } from "@/components/ui/badge";

export type SyncChangeAction = "added" | "changed" | "skipped" | "delete";

export interface SyncChangeRow {
  entity: string;
  key: string;
  action: SyncChangeAction;
}

export interface ParsedSyncResult {
  status: string;
  dryRun: boolean;
  prune: boolean;
  rows: SyncChangeRow[];
  errors: string[];
}

const ENTITY_ORDER = [
  "connection",
  "resourceServer",
  "hookCode",
  "action",
  "hook",
  "emailProvider",
  "branding",
  "promptSettings",
];

const ENTITY_LABELS: Record<string, string> = {
  connection: "Connections",
  resourceServer: "Resource servers",
  hookCode: "Hook code",
  action: "Actions",
  hook: "Hooks",
  emailProvider: "Email provider",
  branding: "Branding",
  promptSettings: "Prompt settings",
};

const isRow = (value: unknown): value is SyncChangeRow => {
  const row = value as Partial<SyncChangeRow> | null;
  return (
    !!row &&
    typeof row.entity === "string" &&
    typeof row.key === "string" &&
    typeof row.action === "string"
  );
};

/** The rows of a result from before `rows` existed, read from `changes`. */
function rowsFromChanges(changes: string[]): SyncChangeRow[] {
  return changes.flatMap((change): SyncChangeRow[] => {
    const skip = /^skip ([^:\s]+):(.*) \(the tenant has its own\)$/.exec(
      change,
    );
    if (skip) return [{ entity: skip[1]!, key: skip[2]!, action: "skipped" }];
    const remove = /^delete ([^:\s]+):(.*)$/.exec(change);
    if (remove)
      return [{ entity: remove[1]!, key: remove[2]!, action: "delete" }];
    const other = /^([^:\s]+):(.*)$/.exec(change);
    return other
      ? [{ entity: other[1]!, key: other[2]!, action: "changed" }]
      : [];
  });
}

/** Reads the stored result of a `sync-defaults` operation. Never throws. */
export function parseSyncResult(
  result: Record<string, unknown> | null | undefined,
): ParsedSyncResult | null {
  if (!result) return null;
  const rows = Array.isArray(result.rows)
    ? result.rows.filter(isRow)
    : rowsFromChanges(
        Array.isArray(result.changes) ? (result.changes as string[]) : [],
      );
  return {
    status: String(result.status ?? "unknown"),
    dryRun: result.dry_run === true,
    prune: result.prune === true,
    rows,
    errors: Array.isArray(result.error_messages)
      ? (result.error_messages as unknown[]).map(String)
      : [],
  };
}

function actionBadge(row: SyncChangeRow, parsed: ParsedSyncResult) {
  switch (row.action) {
    case "added":
      return <Badge>{parsed.dryRun ? "would add" : "added"}</Badge>;
    case "changed":
      return (
        <Badge variant="secondary">
          {parsed.dryRun ? "would change" : "changed"}
        </Badge>
      );
    case "skipped":
      return (
        <Badge
          variant="outline"
          title="The tenant has its own row with this key, so the parent's is not copied"
        >
          kept: tenant&apos;s own
        </Badge>
      );
    case "delete":
      return parsed.dryRun ? (
        <Badge
          variant="destructive"
          title="A copy the parent no longer shares. A sync with Remove unshared removes it."
        >
          stale
        </Badge>
      ) : (
        <Badge variant="destructive">removed</Badge>
      );
  }
}

function summary(parsed: ParsedSyncResult): string {
  const count = (action: SyncChangeAction) =>
    parsed.rows.filter((r) => r.action === action).length;
  if (parsed.rows.length === 0 && parsed.errors.length === 0) {
    return parsed.status === "up-to-date"
      ? "Already up to date."
      : "Nothing to change.";
  }
  const parts = [
    [count("added"), parsed.dryRun ? "to add" : "added"],
    [count("changed"), parsed.dryRun ? "to change" : "changed"],
    [count("skipped"), "kept"],
    [count("delete"), parsed.dryRun ? "stale" : "removed"],
  ]
    .filter(([n]) => n)
    .map(([n, label]) => `${n} ${label}`);
  return parts.join(", ");
}

/**
 * What a sync did, or (for a preview) would do, grouped by entity, with the
 * errors it reported. Reads the stored operation result.
 */
export function SyncChanges({
  result,
}: {
  result: Record<string, unknown> | null | undefined;
}) {
  const parsed = parseSyncResult(result);
  if (!parsed) return null;

  const entities = [
    ...ENTITY_ORDER,
    ...[...new Set(parsed.rows.map((r) => r.entity))].filter(
      (e) => !ENTITY_ORDER.includes(e),
    ),
  ].filter((entity) => parsed.rows.some((r) => r.entity === entity));

  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="sync-changes">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{parsed.status}</Badge>
        <span className="text-muted-foreground">
          {parsed.dryRun ? "Preview, nothing was written. " : ""}
          {summary(parsed)}
        </span>
      </div>

      {entities.map((entity) => (
        <div key={entity} className="flex flex-col gap-1">
          <div className="font-medium">{ENTITY_LABELS[entity] ?? entity}</div>
          <ul className="flex flex-col gap-1">
            {parsed.rows
              .filter((r) => r.entity === entity)
              .map((row) => (
                <li
                  key={`${row.action}:${row.key}`}
                  className="flex items-center gap-2"
                >
                  {actionBadge(row, parsed)}
                  <span className="font-mono text-xs">{row.key}</span>
                </li>
              ))}
          </ul>
        </div>
      ))}

      {parsed.errors.length > 0 && (
        <div className="rounded-md border border-destructive/40 p-3">
          <div className="font-medium text-destructive">
            {parsed.errors.length} error{parsed.errors.length === 1 ? "" : "s"}
          </div>
          <ul className="mt-1 flex flex-col gap-1 font-mono text-xs text-destructive">
            {parsed.errors.map((message, i) => (
              <li key={i}>{message}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
