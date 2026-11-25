---
"@authhero/drizzle": patch
---

Fix user signup on better-sqlite3. Creating a user runs inside the adapters' `transaction()`, and the multi-statement insert then started its own `BEGIN`, which SQLite rejects ("Failed to run the query 'BEGIN'"), so every signup failed with a 500. Multi-statement writes (`runAtomic`) and nested `transaction()` calls now join an already open transaction instead of starting a new one. D1 is not affected.
