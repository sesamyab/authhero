---
"@authhero/drizzle": patch
"@authhero/kysely-adapter": patch
---

Connection `show_as_button` and `is_domain_connection` now round-trip as booleans. The drizzle adapter returned them as `0`/`1` and dropped them on update, and the kysely adapter failed to insert them on SQLite. Login screens can now hide a connection with `show_as_button: false`.
