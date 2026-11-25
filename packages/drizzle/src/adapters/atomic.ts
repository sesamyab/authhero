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
// Transaction scopes for sync drivers (better-sqlite3).
//
// better-sqlite3 has a single connection that every request shares, and
// SQLite can't start a transaction within a transaction. Interactive
// BEGIN/COMMIT around async callbacks therefore needs these guarantees:
//
// - Only work that belongs to the open transaction may join it. transaction()
//   hands its callback adapters bound to a scope (see bindToScope).
//   runAtomic and nested transaction() calls made through them join the open
//   transaction; everything else on the connection waits for it to finish.
// - Joined work is all-or-nothing. Each joined runAtomic or nested
//   transaction() runs in its own child scope behind a SAVEPOINT and rolls
//   back to it on failure, so a caller that catches the error and carries on
//   can't commit half of it.
// - Savepoints never overlap. Children of the same scope run one at a time, so
//   siblings started concurrently (Promise.all) can't release or roll back each
//   other's savepoints. Work inside a child uses the child's adapters and nests
//   under it instead of waiting behind it.
//
// D1 never reaches this: it uses db.batch() and runs transaction() callbacks
// directly. Single-statement writes are not queued: made outside the
// transaction helpers they run directly on the shared connection, and inside
// a callback they run in whichever savepoint is open at that moment.
// ---------------------------------------------------------------------------

const SCOPE = Symbol("authhero.drizzle.transactionScope");
const CONNECTION = Symbol("authhero.drizzle.connection");

/**
 * How long a write waits for its turn on the connection or in its scope
 * before giving up. A wait this long almost always means code inside a
 * transaction() callback wrote through adapters other than that callback's
 * own (for example an outer callback's), which would wait for itself forever.
 */
export const transactionLockSettings = { timeoutMs: 10_000 };

/** A level of an open transaction: the transaction itself or a savepoint. */
export interface TransactionScope {
  /** Token of the outermost transaction the scope belongs to. */
  readonly root: symbol;
  /** Settles when the children started in this scope so far have finished. */
  childTail: Promise<void>;
}

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

function scopeOf(db: DrizzleDb): TransactionScope | undefined {
  return (db as unknown as { [SCOPE]?: TransactionScope })[SCOPE];
}

/**
 * Whether `db` belongs to the transaction that currently holds its
 * connection, i.e. it was handed to that transaction's callback (or to a
 * nested callback inside it).
 */
export function ownsOpenTransaction(db: DrizzleDb): boolean {
  const scope = scopeOf(db);
  return scope !== undefined && stateFor(db).owner === scope.root;
}

/**
 * A view of `db` bound to `scope`. Queries run on the same connection; the
 * scope only lets runAtomic and transaction() recognise where work belongs.
 */
export function bindToScope<T extends DrizzleDb>(
  db: T,
  scope: TransactionScope,
): T {
  return Object.create(db, {
    [SCOPE]: { value: scope },
    [CONNECTION]: { value: connectionKey(db) },
  });
}

/**
 * Queue behind `tail` (a promise that settles when the holders before us are
 * done) and return a function that hands the turn to the next waiter. Gives
 * up after transactionLockSettings.timeoutMs.
 */
async function takeTurn(
  queue: { tail: Promise<void> } | { childTail: Promise<void> },
): Promise<() => void> {
  const key = "tail" in queue ? "tail" : "childTail";
  const target = queue as Record<typeof key, Promise<void>>;
  const previous = target[key];
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  target[key] = previous.then(() => released);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      previous,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Timed out after ${transactionLockSettings.timeoutMs} ms waiting for other writes on the same SQLite connection. Inside a transaction() callback, write through the adapters passed to that callback, including in nested callbacks.`,
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
  return release;
}

/**
 * Run `work` once no other transaction holds the connection, holding it until
 * `work` settles. Waiters are served in order. `work` gets the root scope of
 * the new transaction.
 */
export async function runExclusive<T>(
  db: DrizzleDb,
  work: (scope: TransactionScope) => Promise<T>,
): Promise<T> {
  const state = stateFor(db);
  const release = await takeTurn(state);
  const scope: TransactionScope = {
    root: Symbol("transaction"),
    childTail: Promise.resolve(),
  };
  state.owner = scope.root;
  try {
    return await work(scope);
  } finally {
    state.owner = null;
    release();
  }
}

let savepointCounter = 0;

/**
 * Run `work` inside the transaction that `db` belongs to, as a child of
 * `db`'s scope behind a SAVEPOINT. Children of the same scope run one at a
 * time, so their savepoints never overlap. If `work` fails, everything it
 * wrote is rolled back to the savepoint; on success the savepoint is released
 * into the enclosing scope. `work` gets a view of `db` bound to the child
 * scope, so calls it makes through that view nest under the child.
 */
export async function runInChildScope<T>(
  db: DrizzleDb,
  work: (childDb: DrizzleDb) => Promise<T>,
): Promise<T> {
  const parent = scopeOf(db);
  if (!parent) {
    throw new Error("runInChildScope needs a db bound to a transaction scope");
  }
  const release = await takeTurn(parent);
  const child: TransactionScope = {
    root: parent.root,
    childTail: Promise.resolve(),
  };
  // An internal counter, never user input, so a raw identifier is safe.
  const name = sql.raw(`authhero_sp_${++savepointCounter}`);
  try {
    await db.run(sql`SAVEPOINT ${name}`);
    try {
      const result = await work(bindToScope(db, child));
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
  } finally {
    release();
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
 * inside that transaction in a child scope behind a SAVEPOINT instead of their
 * own BEGIN/COMMIT, so a failure still rolls back all of them. Any other call
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
    return runInChildScope(db, () => runInOrder(statements));
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
