---
"authhero": minor
"@authhero/kysely-adapter": minor
"@authhero/adapter-interfaces": minor
"@authhero/drizzle": patch
---

Add an Auth0-compatible **Actions Executions** API.

- New `action_executions` storage entity and adapter (`get`, `create`).
- New management API endpoint `GET /api/v2/actions/executions/:id` returning the Auth0-shape execution object (`id`, `trigger_id`, `status`, `results[]`, `created_at`, `updated_at`). See https://auth0.com/docs/api/management/v2/actions/get-execution.
- Per-action console output is now captured and exposed via the AuthHero-specific endpoint `GET /api/v2/actions/executions/:id/logs` (Auth0 keeps these in a separate real-time logs stream rather than the executions API; we co-locate them so admins have one place to look).
- New dry-run endpoint `POST /api/v2/actions/actions/:id/test` runs an action through the executor with a caller-supplied event payload and returns the result synchronously. Does not persist an execution or replay API calls.
- The hook runtime now writes one execution record per trigger fire (post-login, credentials-exchange, pre-/post-user-registration), aggregating each action's result into the `results[]` array — matching Auth0's per-trigger semantics. Per-hook `sh`/`fh` log entries are no longer emitted from action paths; the credentials-exchange path stamps the resulting tenant log with `details.execution_id` so admins can navigate from a log entry to the execution detail.
- React-admin: action edit page gets a "Test action" panel with per-trigger payload fixtures; the log detail view gets an "Action Execution" tab that resolves `details.execution_id` and shows per-action timings, errors, and captured console output.

The internal trigger id `post-user-login` is normalized to Auth0's `post-login` when persisted in execution records.

The Drizzle adapter ships an `actionExecutions` stub that throws — same pattern as the existing `actions` stub — since action storage is not yet implemented for Drizzle. Use the Kysely adapter when actions are needed.
