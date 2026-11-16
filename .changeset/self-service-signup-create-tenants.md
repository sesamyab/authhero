---
"@authhero/multi-tenancy": minor
---

Add `selfServiceSignup` to `initMultiTenant`, so people who sign up on the control plane can create their own tenant. Once a user's email is verified they get a global role, `Tenant Creator` by default (rename it with `selfServiceSignup: { roleName }`), that carries only `create:tenants` on the Management API. Never `read:tenants`, `delete:tenants` or `admin:organizations`.

Users who arrive verified (social, passwordless) get it at registration, password sign-ups when they verify. Only the control plane tenant is affected, existing users are not backfilled, and it is off by default. It runs through `onExecutePostUserRegistration` and `onExecutePostUserUpdate` ahead of your own hooks, and it needs `controlPlane` to be set. The role is created on first use and `create:tenants` is added to an existing role if missing; other permissions on it are kept. `createSelfServiceSignupHooks` is exported for hosts that wire hooks themselves.

Closes #1717.
