---
"authhero": patch
"@authhero/cloudflare-adapter": patch
---

Follow-ups to the `tenantDispatch` carve-out from #1633:

- The carve-out now matches only at the start of the path, below where the management API is mounted. A tenant's own resource whose name or id happens to be `operations`, `rollouts` or `tenant-members` (for example `/organizations/name/operations`) is forwarded to its worker again instead of being answered by the control plane.
- The paths are recorded where those routes are mounted, so the carve-out follows the mount conditions. An extension that overrides `/tenant-members` is no longer carved out.
- The control-plane tenant-members resource names what is missing in an `X-Authhero-Not-Found` header (`organization` or `invitation`). The remote adapter reads it, so a missing invitation surfaces as a missing invitation rather than a missing team, and a not-found whose body was lost is no longer reported as a 502. Control planes from before the header still work through the `Not found` body.
- `createWfpForwardMiddleware` warns when it is given `localPaths: []` without `includeDefaultLocalPaths`, since an empty list no longer turns the default carve-out off.
