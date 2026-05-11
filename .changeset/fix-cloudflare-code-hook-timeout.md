---
"authhero": patch
---

Fix Cloudflare code hooks failing silently. `handleCodeHook` always passed `timeoutMs: 5000` to `codeExecutor.execute`, and `CloudflareCodeExecutor` threw on any `timeoutMs`/`cpuLimitMs` it didn't enforce. The throw escaped back to the post-login flow, where the catch logged only `"Failed to execute code hook: <hook_id>"` with no error detail — so every Cloudflare-deployed code hook failed without diagnostic. `CloudflareCodeExecutor` now accepts and ignores these params (they were unenforceable through the Worker Loader API anyway), and the FAILED_HOOK / FAILED_SIGNUP log entries in `post-user-login.ts`, `user-registration.ts`, and `codehooks.ts` now include the underlying error message and a `details` bag.
