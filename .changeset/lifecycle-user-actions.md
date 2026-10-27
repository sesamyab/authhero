---
"authhero": minor
"@authhero/adapter-interfaces": minor
"@authhero/admin": minor
---

Support stored Actions for pre/post user update and deletion, including trigger bindings and admin starter code. Pre Actions can deny writes and fail closed on execution errors. Post Actions use the transactional outbox with idempotency keys and sanitized previous-user/update snapshots, or best-effort delivery without an outbox. Preserve accounts and sessions when SCIM or self-service deletion is denied, and support existing control-plane publishing for lifecycle Actions and bindings.

Protect enforced synced policies from removal through trigger binding replacement, enforce a five-second host deadline for Action execution, and keep deletion cleanup retryable by approving policies before cleanup and committing deletion afterward.
