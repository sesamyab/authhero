---
"authhero": patch
---

Keep `hono` subpath imports (`hono/route`, `hono/http-exception`, `hono/jsx`, ...) external in the server build instead of inlining them. The bundled `hono/route` had its own copy of Hono's match-result symbol, so the `tenantDispatch` carve-out from 9.28.0 called `basePath(ctx)` against the host app's Hono and every management API request answered 500 (`Cannot read properties of undefined (reading '0')`) whenever `tenantDispatch` was set. HTTPExceptions thrown by authhero now also pass the host app's `instanceof HTTPException` checks.
