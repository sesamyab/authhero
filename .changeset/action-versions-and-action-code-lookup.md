---
"authhero": minor
"@authhero/adapter-interfaces": minor
"@authhero/kysely-adapter": minor
"@authhero/drizzle": patch
---

Add deployment history for actions and fix the runtime lookup that prevented Auth0-style actions from firing.

- The post-login (and other code-hook) dispatcher previously only resolved code via the legacy `data.hookCode` table. Actions created through the Auth0-compatible `POST /api/v2/actions/actions` API live in `data.actions` and were silently skipped at runtime. `handleCodeHook` now resolves `code_id` from `data.actions` first and falls back to `data.hookCode`, so deployed actions bound to a trigger actually run.
- New `actionVersions` adapter (kysely + stub for drizzle) plus a `2026-05-10` migration creating the `action_versions` table. A version row is snapshotted on every action create and on every `POST /api/v2/actions/actions/:id/deploy`, with the latest snapshot marked `deployed: true` and any prior versions cleared.
- New management API routes: `GET /api/v2/actions/actions/:actionId/versions`, `GET /api/v2/actions/actions/:actionId/versions/:id`, and `POST /api/v2/actions/actions/:actionId/versions/:id/deploy` (rollback). Rollback re-deploys the rolled-back version's code via the configured `codeExecutor` and snapshots a new version row so history reflects the rollback.
- Deleting an action now also removes its version history.
