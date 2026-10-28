import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { CHANGE_TONE_CLASS, type ChangeTone } from "./changeTone";

/**
 * `added`, `changed`, `skipped` and `delete` come from a sync; `converted`,
 * `removed` and `kept` from a detach.
 */
export type SyncChangeAction =
  | "added"
  | "changed"
  | "skipped"
  | "delete"
  | "converted"
  | "removed"
  | "kept";

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

function toneBadge(tone: ChangeTone, label: string, title?: string) {
  return (
    <Badge variant="outline" className={CHANGE_TONE_CLASS[tone]} title={title}>
      {label}
    </Badge>
  );
}

function actionBadge(row: SyncChangeRow, parsed: ParsedSyncResult) {
  const would = (now: string, preview: string) =>
    parsed.dryRun ? preview : now;
  switch (row.action) {
    case "added":
      return toneBadge("add", would("added", "would add"));
    case "changed":
      return toneBadge("change", would("changed", "would change"));
    case "skipped":
      return toneBadge(
        "keep",
        "kept: tenant's own",
        "The tenant has its own row with this key, so the parent's is not copied",
      );
    case "converted":
      return toneBadge("convert", would("converted", "would convert"));
    case "removed":
      return toneBadge("remove", would("removed", "would remove"));
    case "kept":
      return toneBadge(
        "keep",
        "kept as copy",
        "A platform row runs for the tenant but is hidden from its admins, so it stays as a copy",
      );
    case "delete":
      return parsed.dryRun
        ? toneBadge(
            "remove",
            "stale",
            "A copy the parent no longer shares. A sync with Remove unshared removes it.",
          )
        : toneBadge("remove", "removed");
  }
}

const isKept = (row: SyncChangeRow) =>
  row.action === "skipped" || row.action === "kept";

/** Rows shown before "Show all". */
const COLLAPSED_ROWS = 10;

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
    [count("converted"), parsed.dryRun ? "to convert" : "converted"],
    [count("removed"), parsed.dryRun ? "to remove" : "removed"],
    [count("kept"), "kept as copy"],
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
  const [showKept, setShowKept] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const parsed = parseSyncResult(result);
  if (!parsed) return null;

  const entityRank = (entity: string) => {
    const rank = ENTITY_ORDER.indexOf(entity);
    return rank === -1 ? ENTITY_ORDER.length : rank;
  };
  const ordered = [...parsed.rows].sort(
    (a, b) => entityRank(a.entity) - entityRank(b.entity),
  );
  // Rows that stay as they are are the ones least looked for: behind a toggle
  // when there is something else to read.
  const keptCount = ordered.filter(isKept).length;
  const collapseKept = keptCount > 0 && keptCount < ordered.length;
  const visible =
    collapseKept && !showKept ? ordered.filter((r) => !isKept(r)) : ordered;
  const shown = showAll ? visible : visible.slice(0, COLLAPSED_ROWS);

  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="sync-changes">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{parsed.status}</Badge>
        <span className="text-muted-foreground">
          {parsed.dryRun ? "Preview, nothing was written. " : ""}
          {summary(parsed)}
        </span>
      </div>

      {visible.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Entity</TableHead>
              <TableHead>Key</TableHead>
              <TableHead>Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((row) => (
              <TableRow key={`${row.entity}:${row.action}:${row.key}`}>
                <TableCell className="text-muted-foreground">
                  {ENTITY_LABELS[row.entity] ?? row.entity}
                </TableCell>
                <TableCell className="font-mono text-xs break-all">
                  {row.key}
                </TableCell>
                <TableCell>{actionBadge(row, parsed)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <div className="flex flex-wrap gap-2">
        {visible.length > COLLAPSED_ROWS && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? "Show fewer" : `Show all ${visible.length}`}
          </Button>
        )}
        {collapseKept && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowKept((v) => !v)}
          >
            {showKept ? "Hide kept rows" : `Show ${keptCount} kept`}
          </Button>
        )}
      </div>

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
