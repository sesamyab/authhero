/**
 * Rows delivered by a config sync (`applyResolvedConfigBlock` in
 * `@authhero/multi-tenancy`) get a deterministic id: the entity's usual prefix,
 * the marker `sy`, and 15 hex characters. The marker tells a tenant's own rows
 * from copies of rows owned by one of its parents.
 */
const SYNCED_ROW_ID = /^(con_|api_|h_|hc_|act_)sy[0-9a-f]{15}$/;

export function isSyncedRowId(id: string | undefined | null): boolean {
  return typeof id === "string" && SYNCED_ROW_ID.test(id);
}
