---
"@authhero/react-admin": patch
---

Fix org-scoped users getting 403 on tenant-scoped management API calls.

- `createManagementClient` now passes the auth0 SDK a token supplier function instead of a captured token, so each SDK request resolves a fresh org-scoped token via `getOrgAccessToken` rather than reusing one captured at construction time.
- The `isSingleTenant` sessionStorage check now requires the stored entry's domain prefix to match the current domain. Previously a stale `…|true` flag from any prior domain would steer multi-tenant requests to the non-org token path and pin a non-org token into the management client cache.
- The same domain-aware check is applied in `dataProvider.ts` and `UniversalLoginTab.tsx`.
