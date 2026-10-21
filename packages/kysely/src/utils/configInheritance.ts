/**
 * Config inheritance publishing fields (`scope`, `override`, `enforce`) are
 * nullable columns. `scope` and `override` are stored as-is; `enforce` is a
 * boolean stored as 0/1. NULL reads as "unset", which means today's behaviour
 * (local / none / false).
 */

export function enforceToSql(
  enforce: boolean | null | undefined,
): number | null | undefined {
  if (enforce === undefined || enforce === null) return enforce;
  return enforce ? 1 : 0;
}

export function enforceFromSql(
  enforce: number | null | undefined,
): boolean | undefined {
  return enforce === undefined || enforce === null ? undefined : !!enforce;
}
