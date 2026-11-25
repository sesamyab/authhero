---
"@authhero/drizzle": patch
---

Fix user signup on better-sqlite3. Creating a user runs inside the adapters' `transaction()`, and the multi-statement insert then started its own `BEGIN`, which SQLite rejects ("Failed to run the query 'BEGIN'"), so every signup failed with a 500.

On better-sqlite3, `transaction()` now hands its callback adapters bound to that transaction. Multi-statement writes (`runAtomic`) and nested `transaction()` calls made through them run inside it. Any other caller on the shared connection waits for the open transaction to finish instead of failing or writing into a transaction it doesn't own. A write that waits more than 10 seconds fails with an error that points at the usual cause: code inside a `transaction()` callback writing through adapters other than the callback's own. D1 is not affected.
