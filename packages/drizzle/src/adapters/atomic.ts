import { sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleDb } from "./types";

export type SqliteBatchItem = BatchItem<"sqlite">;

/** A non-empty list of write statements to apply as a single atomic unit. */
type AtomicStatements = readonly [SqliteBatchItem, ...SqliteBatchItem[]];

/** Mutable variant call sites build up before passing to {@link runAtomic}. */
export type AtomicStatementList = [SqliteBatchItem, ...SqliteBatchItem[]];

/**
 * The async (D1) driver exposes `batch()`, which executes its statements as a
 * single atomic unit. The sync better-sqlite3 driver used in tests does not, so
 * `DrizzleDb` (shared across both) can't declare it. We feature-detect instead.
 */
interface BatchCapableDb {
  batch(statements: AtomicStatements): Promise<unknown[]>;
}

export function hasBatch(db: DrizzleDb): db is DrizzleDb & BatchCapableDb {
  const candidate: unknown = db;
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    "batch" in candidate &&
    typeof candidate.batch === "function"
  );
}

// ---------------------------------------------------------------------------
// Transaction ownership and queueing for sync drivers (better-sqlite3).
//
// better-sqlite3 has a single connection that every request shares, and
// SQLite can't start a transaction within a transaction. Interactive
// BEGIN/COMMIT around an async callback therefore needs two guarantees:
//
// - Only work that belongs to the open transaction may join it. The adapters'
//   transaction() hands its callback adapters bound to a token for that
//   transaction (see bindToTransaction); runAtomic and nested transaction()
//   calls made through those adapters run inside it.
// - Everything else waits. Another request's transaction() or runAtomic queues
//   until the open transaction commits or rolls back, instead of failing on
//   BEGIN or silently writing into a transaction it doesn't own (and losing
//   its rows on that transaction's ROLLBACK).
//
// D1 never reaches this: it uses db.batch() and runs transaction() callbacks
// directly. Single-statement writes made outside the adapters' transaction
// helpers still run on the shared connection and are not queued.
// ---------------------------------------------------------------------------

const TRANSACTION_TOKEN = Symbol("authhero.drizzle.transactionToken");
const CONNECTION = Symbol("authhero.drizzle.connection");

/**
 * How long a write waits for another transaction on the same connection
 * before giving up. A wait this long almost always means code inside a
 * transaction() callback wrote through adapters that are not the callback's
 * own, which would otherwise wait for itself forever.
 */
export const transactionLockSettings = { timeoutMs: 10_000 };

interface ConnectionState {
  /** Token of the transaction that currently holds the connection. */
  owner: symbol | null;
  /** Settles when every queued holder so far has released the connection. */
  tail: Promise<void>;
}

const connectionStates = new WeakMap<object, ConnectionState>();

function connectionKey(db: DrizzleDb): object {
  const candidate = db as unknown as {
    $client?: unknown;
    [CONNECTION]?: object;
  };
  if (typeof candidate.$client === "object" && candidate.$client !== null) {
    return candidate.$client;
  }
  return candidate[CONNECTION] ?? (db as unknown as object);
}

function stateFor(db: DrizzleDb): ConnectionState {
  const key = connectionKey(db);
  let state = connectionStates.get(key);
  if (!state) {
    state = { owner: null, tail: Promise.resolve() };
    connectionStates.set(key, state);
  }
  return state;
}

/**
 * Whether `db` belongs to the transaction that currently holds its
 * connection, i.e. it was handed to that transaction's callback.
 */
export function ownsOpenTransaction(db: DrizzleDb): boolean {
  const token = (db as unknown as { [TRANSACTION_TOKEN]?: symbol })[
    TRANSACTION_TOKEN
  ];
  return token !== undefined && stateFor(db).owner === token;
}

/**
 * A view of `db` bound to the transaction `token`. Queries run on the same
 * connection; the token only lets runAtomic and transaction() recognise work
 * that belongs to the open transaction.
 */
export function bindToTransaction<T extends DrizzleDb>(
  db: T,
  token: symbol,
): T {
  return Object.create(db, {
    [TRANSACTION_TOKEN]: { value: token },
    [CONNECTION]: { value: connectionKey(db) },
  });
}

/**
 * Run `work` once no other transaction holds the connection, holding it until
 * `work` settles. Waiters are served in order.
 */
export async function runExclusive<T>(
  db: DrizzleDb,
  work: (token: symbol) => Promise<T>,
): Promise<T> {
  const state = stateFor(db);
  const previous = state.tail;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.tail = previous.then(() => released);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      previous,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Timed out after ${transactionLockSettings.timeoutMs} ms waiting for another transaction on the same SQLite connection. Inside a transaction() callback, write through the adapters passed to the callback.`,
              ),
            ),
          transactionLockSettings.timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    release();
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const token = Symbol("transaction");
  state.owner = token;
  try {
    return await work(token);
  } finally {
    state.owner = null;
    release();
  }
}

let savepointCounter = 0;

/**
 * Run `work` inside the transaction that `db` already owns, behind a SAVEPOINT.
 * If `work` fails, everything it wrote is rolled back to the savepoint, so a
 * caller that catches the error and carries on cannot commit half of it. On
 * success the savepoint is released into the enclosing transaction.
 */
export async function runInSavepoint<T>(
  db: DrizzleDb,
  work: () => Promise<T>,
): Promise<T> {
  // An internal counter, never user input, so a raw identifier is safe.
  const name = sql.raw(`authhero_sp_${++savepointCounter}`);
  await db.run(sql`SAVEPOINT ${name}`);
  try {
    const result = await work();
    await db.run(sql`RELEASE ${name}`);
    return result;
  } catch (error) {
    try {
      await db.run(sql`ROLLBACK TO ${name}`);
      await db.run(sql`RELEASE ${name}`);
    } catch (rollbackError) {
      console.error("savepoint rollback failed", rollbackError);
    }
    throw error;
  }
}

async function runInOrder(statements: AtomicStatements): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const statement of statements) {
    results.push(await statement);
  }
  return results;
}

/**
 * Apply a set of dependent write statements atomically across drivers.
 *
 * On D1 (async) this uses `db.batch()`, which D1 runs as one atomic unit, so a
 * failure of any statement (or the commit) leaves nothing persisted. On
 * better-sqlite3 (sync, tests) it falls back to manual `BEGIN/COMMIT/ROLLBACK`,
 * because that driver has no `batch()` and Drizzle's `db.transaction()` can't
 * await an async callback there. Interactive `BEGIN/COMMIT` is *not* atomic on
 * D1, which is why the batch path exists.
 *
 * On better-sqlite3, statements made through a transaction's own adapters run
 * inside that transaction behind a SAVEPOINT instead of their own
 * BEGIN/COMMIT, so a failure still rolls back all of them. Any other call
 * waits for an open transaction to finish before starting its own.
 *
 * Returns the per-statement results in order (the batch response on D1; each
 * awaited builder's result on better-sqlite3).
 */
export async function runAtomic(
  db: DrizzleDb,
  statements: AtomicStatements,
): Promise<unknown[]> {
  if (hasBatch(db)) {
    return db.batch(statements);
  }

  if (ownsOpenTransaction(db)) {
    return runInSavepoint(db, () => runInOrder(statements));
  }

  return runExclusive(db, async () => {
    await db.run(sql`BEGIN`);
    try {
      const results = await runInOrder(statements);
      await db.run(sql`COMMIT`);
      return results;
    } catch (error) {
      // Roll back best-effort: a failing ROLLBACK must not mask the original
      // write/commit error that actually explains what went wrong.
      try {
        await db.run(sql`ROLLBACK`);
      } catch (rollbackError) {
        console.error("runAtomic rollback failed", rollbackError);
      }
      throw error;
    }
  });
}
