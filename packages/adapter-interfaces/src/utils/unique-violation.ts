const UNIQUE_VIOLATION_CODES = new Set<unknown>([
  // better-sqlite3 / node:sqlite
  "SQLITE_CONSTRAINT_UNIQUE",
  "SQLITE_CONSTRAINT_PRIMARYKEY",
  // mysql2
  "ER_DUP_ENTRY",
  1062,
  // postgres
  "23505",
]);

const UNIQUE_VIOLATION_MESSAGES = [
  // SQLite, D1 ("D1_ERROR: UNIQUE constraint failed: ...")
  "UNIQUE constraint failed",
  // MySQL
  "Duplicate entry",
  // PlanetScale serverless driver (Vitess error body)
  "AlreadyExists",
  // Postgres
  "duplicate key",
];

/**
 * Whether a database driver error is a unique / primary-key constraint
 * violation, across the drivers the SQL adapters run on (SQLite, D1, MySQL,
 * PlanetScale, Postgres).
 *
 * Walks the `cause` chain because drizzle-orm wraps driver errors in a
 * `DrizzleQueryError` whose own message is "Failed query: ...".
 */
export function isUniqueViolation(err: unknown): boolean {
  let current: unknown = err;
  // Bounded so a self-referencing cause can't loop forever.
  for (let depth = 0; depth < 5; depth++) {
    if (typeof current !== "object" || current === null) return false;

    if ("code" in current && UNIQUE_VIOLATION_CODES.has(current.code)) {
      return true;
    }
    if ("errno" in current && current.errno === 1062) return true;

    const message =
      "message" in current && typeof current.message === "string"
        ? current.message
        : "";
    if (UNIQUE_VIOLATION_MESSAGES.some((m) => message.includes(m))) {
      return true;
    }

    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
