---
"@authhero/react-admin": patch
---

Fix tenants list at the root showing only the user's current organization. The Auth0 SPA-JS cache is keyed on clientId+audience+scope (no org), so an org-scoped token from a prior tenant page could be returned for the non-org-scoped tenants request. Mirror the existing `orgTokenCache` with a `nonOrgTokenCache` and force `cacheMode: "off"` when fetching the non-org token.
