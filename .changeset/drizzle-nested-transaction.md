---
"@authhero/drizzle": patch
---

Fix user signup on better-sqlite3. Creating a user runs inside the adapters' `transaction()`, and the multi-statement insert then started its own `BEGIN`, which SQLite rejects ("Failed to run the query 'BEGIN'"), so every signup failed with a 500.

On better-sqlite3, `transaction()` now hands its callback adapters bound to that transaction:

- Multi-statement writes (`runAtomic`) and nested `transaction()` calls made through them join the open transaction. Each one runs in its own scope behind a SAVEPOINT, so a failed one is rolled back even if the callback catches the error.
- Joined writes in the same scope run one at a time, so concurrent siblings (for example `Promise.all`) can't release or roll back each other's savepoints. Calls made inside a nested callback through its own adapters nest under it.
- Any other caller on the shared connection waits for the open transaction to finish, instead of failing or writing into a transaction it doesn't own.
- A write that waits more than 10 seconds fails with an error. That almost always means code inside a `transaction()` callback wrote through adapters other than that callback's own.

D1 is not affected.
