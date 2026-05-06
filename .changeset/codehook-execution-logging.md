---
"@authhero/adapter-interfaces": minor
"authhero": minor
---

Capture `console.*` output from dynamic code hooks and emit a log entry for every execution.

- Added `SUCCESS_HOOK` (`"sh"`) log type and a new `CodeExecutionLog` shape on `CodeExecutionResult.logs`.
- The Cloudflare and Local executors now shadow `console` inside the sandbox and return up to 50 captured entries (each truncated to 500 chars) per execution.
- `handleCodeHook` now writes a `SUCCESS_HOOK` log on success and a `FAILED_HOOK` log on failure, with `hook_id`, `code_id`, `trigger_id`, `duration_ms`, recorded `api_calls`, and the captured `logs` array on the log's `details` payload — surfacing dynamic-action execution in the tenant log feed for debugging.
