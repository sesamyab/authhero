---
"@authhero/cloudflare-adapter": patch
---

Apply pending WFP tenant D1 migrations in one D1 `/query` call (split into ~90 KB chunks of whole migrations) instead of two calls per migration, so a first-time provision stays under the Workers 50-subrequest limit. Each migration's SQL is still followed by its tracking row, and a failed combined call is retried one migration at a time so the error names the failing migration.
