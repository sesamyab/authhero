---
"@authhero/cloudflare-adapter": minor
---

`createWfpForwardMiddleware`'s `localPaths` now adds to the default carve-out (`DEFAULT_LOCAL_PATHS`, exported) instead of replacing it, so a default added later is not silently dropped by callers that pass their own list. To carve out only your own paths, pass `includeDefaultLocalPaths: false`. Note that `localPaths: []` no longer disables the `/u/widget/` carve-out; use `includeDefaultLocalPaths: false` for that.
