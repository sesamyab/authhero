---
"@authhero/react-admin": patch
---

Fix repeated refresh-token calls on every navigation:

- Dedupe in-flight access-token requests so concurrent API calls on a cold token cache share a single refresh-token exchange instead of each firing their own.
- Fix the cached-token org-match check, which compared the org slug passed as `organization` against the JWT's `org_id` (the resolved id, not the slug). Every cache hit failed the guard and was evicted, forcing a refresh on every click. Now matches against either `org_id` or `org_name`.
