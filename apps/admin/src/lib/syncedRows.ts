/**
 * Rows a sync wrote into this tenant have deterministic ids with an `sy`
 * marker: `<prefix>sy<15 hex>`, the same shape the server checks with
 * `isSyncedRowId`.
 */
const SYNCED_ROW_ID = /^(con_|api_|h_|hc_|act_)sy[0-9a-f]{15}$/;

export function isSyncedRowId(id: unknown): boolean {
  return typeof id === "string" && SYNCED_ROW_ID.test(id);
}

/** Id of a list/edit record: hooks carry `hook_id` as well as `id`. */
export function rowIdOf(
  record: { id?: unknown; hook_id?: unknown } | undefined,
): string | undefined {
  const id = record?.id ?? record?.hook_id;
  return typeof id === "string" ? id : undefined;
}

/**
 * A row copied from a parent whose `override` allows no changes. An unset
 * override is "fields" (the server treats it the same way), so it stays
 * editable.
 */
export function isLockedInheritedRow(
  record:
    | { id?: unknown; hook_id?: unknown; override?: string | null }
    | undefined
    | null,
): boolean {
  return (
    !!record &&
    isSyncedRowId(rowIdOf(record)) &&
    (record.override ?? "fields") === "none"
  );
}
