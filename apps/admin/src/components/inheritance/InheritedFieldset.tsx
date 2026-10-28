import type { ReactNode } from "react";
import { useRecordContext } from "ra-core";
import { Lock } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useConfigSyncStatus } from "@/hooks/useConfigSyncStatus";
import { isLockedInheritedRow, isSyncedRowId, rowIdOf } from "@/lib/syncedRows";

interface PublishedRecord {
  id?: string;
  hook_id?: string;
  override?: "none" | "secrets" | "fields" | null;
  enforce?: boolean | null;
}

/**
 * What the record being edited is, as an inherited row: whether it was copied
 * from a parent, where from, and what the tenant may change on it. An unset
 * `override` is "fields" - the server treats it the same way.
 */
export function useInheritedRow() {
  const record = useRecordContext<PublishedRecord>();
  const { status } = useConfigSyncStatus();
  const id = rowIdOf(record);
  const inherited = isSyncedRowId(id);
  const override = record?.override ?? "fields";
  return {
    inherited,
    from: id ? status?.inherited[id] : undefined,
    override,
    enforce: !!record?.enforce,
    /** Nothing may be changed on this row. */
    locked: isLockedInheritedRow(record),
    secretsOnly: inherited && override === "secrets",
  };
}

/**
 * Wraps an edit form. For a row inherited from a parent it says so and, when
 * the parent allows no changes, disables the form. The server enforces the
 * same rules (`protect-synced`); this only keeps the UI honest about them.
 */
export function InheritedFieldset({ children }: { children: ReactNode }) {
  const row = useInheritedRow();
  if (!row.inherited) return <>{children}</>;

  return (
    <div className="flex flex-col gap-4">
      <Alert className="border-sky-600/30 bg-sky-50 text-sky-950 dark:border-sky-500/30 dark:bg-sky-950/40 dark:text-sky-100">
        <Lock className="h-4 w-4" />
        <AlertDescription className="block text-sky-900 dark:text-sky-200">
          Inherited from <strong>{row.from ?? "a parent tenant"}</strong>.{" "}
          {row.locked
            ? "The parent allows no changes here."
            : row.secretsOnly
              ? "Only secrets can be changed here; everything else follows the parent."
              : "Changes you make are replaced the next time the parent's config is synced."}
          {row.enforce && " It cannot be disabled or deleted."}
        </AlertDescription>
      </Alert>
      <fieldset
        disabled={row.locked}
        className="contents"
        data-testid="inherited-fieldset"
      >
        {children}
      </fieldset>
    </div>
  );
}
