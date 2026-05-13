---
"authhero": patch
---

Enrich the audit logs emitted when a user-lifecycle hook (`onExecutePreUserRegistration`, `onExecutePostUserRegistration`, `onExecutePostUserDeletion`, and the post-registration / post-update template hooks) throws a non-`HTTPException` error. Each log now carries the subject `user_id`, the user's `connection`, the failing identifier in the description, and a `details` payload including the error name, stack trace, email/phone, and provider — so failures are queryable per user and the originating hook line is recoverable from logs. Behavior is unchanged: these errors are still swallowed and the operation continues. Hooks that need to abort must call `api.access.deny(...)` (registration) or throw `HTTPException` directly.
