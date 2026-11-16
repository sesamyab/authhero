/**
 * A tiny stand-in for the Analytics Engine SQL API: it evaluates the aggregate
 * expressions an adapter put in its SELECT list over a fixed set of stored
 * rows, each carrying the `_sample_interval` Analytics Engine attaches when it
 * samples a dataset.
 *
 * It deliberately ignores WHERE, GROUP BY and ORDER BY: tests hand it rows
 * that already belong to the single group they assert on. What it does model
 * is the difference between counting stored rows and counting events, which is
 * what the sampling tests are about. Unsupported expressions throw so a test
 * can't pass by accident.
 */
export interface StoredRow {
  blob3: string;
  blob7?: string;
  _sample_interval: number;
}

const AGGREGATE_PATTERN =
  /(SUM\(CASE WHEN .+? END\)|SUM\(_sample_interval\)|count\(\)|count\(DISTINCT \w+\))\s+AS\s+"?(\w+)"?/gi;

function matchesCondition(condition: string, row: StoredRow): boolean {
  const inList = /^blob3 IN \((.+)\)$/.exec(condition);
  if (inList?.[1]) {
    const values = inList[1].split(",").map((v) => v.trim().slice(1, -1));
    return values.includes(row.blob3);
  }
  const equals = /^blob3 = '(.*)'$/.exec(condition);
  if (equals) {
    return row.blob3 === equals[1];
  }
  throw new Error(`fake Analytics Engine: unsupported condition ${condition}`);
}

function evaluate(expr: string, rows: StoredRow[]): number {
  if (/^count\(\)$/i.test(expr)) {
    return rows.length;
  }
  if (expr === "SUM(_sample_interval)") {
    return rows.reduce((total, row) => total + row._sample_interval, 0);
  }
  const distinct = /^count\(DISTINCT (\w+)\)$/i.exec(expr);
  if (distinct) {
    if (distinct[1] !== "blob7") {
      throw new Error(`fake Analytics Engine: unsupported column ${expr}`);
    }
    return new Set(rows.map((row) => row.blob7).filter(Boolean)).size;
  }
  const caseWhen =
    /^SUM\(CASE WHEN (.+) THEN (1|_sample_interval) ELSE 0 END\)$/.exec(expr);
  if (caseWhen?.[1]) {
    const condition = caseWhen[1];
    const weighted = caseWhen[2] === "_sample_interval";
    return rows
      .filter((row) => matchesCondition(condition, row))
      .reduce((total, row) => total + (weighted ? row._sample_interval : 1), 0);
  }
  throw new Error(`fake Analytics Engine: unsupported aggregate ${expr}`);
}

/**
 * Evaluate every aggregate in `sql`'s SELECT list over `rows` and return them
 * as one result row keyed by alias, merged over `extra` (e.g. a date column).
 */
export function aggregateRow(
  sql: string,
  rows: StoredRow[],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...extra };
  for (const match of sql.matchAll(AGGREGATE_PATTERN)) {
    const [, expr, alias] = match;
    if (expr && alias) {
      result[alias] = evaluate(expr, rows);
    }
  }
  return result;
}
