---
"@authhero/cloudflare-adapter": minor
"authhero": minor
---

Move the Worker Loader code executor into `@authhero/cloudflare-adapter` and rename both Cloudflare code executors so the naming reflects which Cloudflare primitive each one uses.

- New: `WorkerLoaderCodeExecutor` in `@authhero/cloudflare-adapter` — uses the Worker Loader binding to create isolates on the fly from in-memory code. Previously exported as `CloudflareCodeExecutor` from `authhero`.
- Renamed: `CloudflareCodeExecutor` → `DispatchNamespaceCodeExecutor` in `@authhero/cloudflare-adapter` — uses a Workers for Platforms dispatch namespace and requires user code to be pre-deployed as worker scripts.
- Deprecated alias: `CloudflareCodeExecutor` / `CloudflareCodeExecutorConfig` remain exported from `@authhero/cloudflare-adapter` as aliases of the dispatch-namespace executor, to be removed in the next major.
- `authhero` no longer re-exports `CloudflareCodeExecutor`. Import the executor from `@authhero/cloudflare-adapter` instead. `LocalCodeExecutor` continues to be exported from `authhero` since it is platform-agnostic.

Migration:
```ts
// Before
import { CloudflareCodeExecutor } from "authhero";
const exec = new CloudflareCodeExecutor({ loader: env.LOADER });

// After
import { WorkerLoaderCodeExecutor } from "@authhero/cloudflare-adapter";
const exec = new WorkerLoaderCodeExecutor({ loader: env.LOADER });
```

In the same change, `globalOutbound: null` is removed from the Worker Loader executor's `WorkerCode`, so user actions can now make outbound `fetch()` calls (Slack webhooks, email APIs, etc.). The Worker Loader still provides v8-level isolation from the parent worker's bindings — this only widens the network boundary, not the host boundary. Previously, any `fetch()` from action code failed with *"This worker is not permitted to access the internet via global functions like fetch()"*.
