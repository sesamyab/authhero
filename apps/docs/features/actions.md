---
title: Actions
description: Auth0-compatible Actions in AuthHero. Store JavaScript in the tenant, bind it to triggers, test, version and deploy it, and inspect executions through the Management API or the admin UI.
---

# Actions

AuthHero implements Auth0's Actions model. An Action is JavaScript stored in the
tenant. You bind it to a trigger, and AuthHero runs it in a sandboxed code
executor when that trigger fires. The `/api/v2/actions/*` Management API follows
Auth0's contract, so Actions written for Auth0, and tools such as the Auth0
Terraform provider and Deploy CLI, work with few or no changes. The differences
are listed under [Differences from Auth0](#differences-from-auth0).

Actions are one of several ways to customize a flow. They can be combined with
the other kinds of hooks:

| Mechanism                                          | Where it lives                       | Use it for                                                         |
| -------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------ |
| **Actions** (this page)                            | Stored per tenant, run in a sandbox  | Tenant-specific logic edited without redeploying AuthHero           |
| [Config hooks](./hooks.md#code-based-hooks)         | Functions passed to `init({ hooks })` | Logic that ships with your deployment and needs full server access |
| [Webhooks](./hooks.md#webhooks)                     | `POST /api/v2/hooks` with a `url`    | Notifying an external service                                      |
| [Form and page hooks](./hooks.md#form-hooks)        | `POST /api/v2/hooks` with a form/page | Collecting input from the user after login                         |
| [Template hooks](../auth0-comparison/hooks.md#hook-templates) | Built-in functions             | Common behaviour such as account linking, without writing code     |

## Concepts

- **Action**: a named script with its code, the triggers it supports, and its
  secrets. Actions live in the admin's **Actions** library.
- **Binding**: connects an Action to a trigger. AuthHero stores a binding as a
  code hook (a row in `hooks` with `code_id` set to the Action ID). The admin's
  **Triggers** page lists every binding type per trigger, including webhooks,
  forms and templates.
- **Version**: a snapshot of the code, secrets and triggers, taken on each deploy.
  You can deploy an earlier version again to roll back.
- **Execution**: one record per trigger run. It holds the status, the result of
  every Action that ran, and the captured console output.

## Enabling Actions

Actions only run when a code executor is configured. Without one, Actions can be
stored and edited, but they don't execute (see
[Errors and timeouts](#errors-and-timeouts) for what that means per trigger).

```typescript
import { init } from "authhero";
import { WorkerLoaderCodeExecutor } from "@authhero/cloudflare-adapter";

const { app } = init({
  dataAdapter,
  codeExecutor: new WorkerLoaderCodeExecutor({ loader: env.LOADER }),
});
```

| Executor                   | Package                       | Isolation                                                         |
| -------------------------- | ----------------------------- | ----------------------------------------------------------------- |
| `WorkerLoaderCodeExecutor` | `@authhero/cloudflare-adapter` | Each Action runs in its own V8 isolate (Cloudflare Dynamic Workers) |
| `LocalCodeExecutor`        | `authhero`                    | None. It runs code with `new Function()`, for local development only |

See [Code Executors](./hooks.md#code-executors) for the Wrangler configuration and
how workers are cached.

## Writing an Action

An Action exports one handler per trigger it supports. The handler receives the
`event` and an `api` object:

```javascript
exports.onExecuteCredentialsExchange = async (event, api) => {
  if (event.client.metadata?.tier === "partner") {
    api.accessToken.setCustomClaim("https://example.com/tier", "partner");
  }
};
```

How the sandbox works:

- **Calls are recorded, then applied.** Inside the sandbox, `api` is a recording
  proxy. Each `api.namespace.method(...)` call is captured, and AuthHero applies
  the calls to the real request after the handler returns. That is why every
  `api` method returns nothing. For example, `api.users.ensure()` doesn't return
  the user.
- **`fetch` is allowed** with `WorkerLoaderCodeExecutor`, so an Action can call
  your own APIs, Slack and similar services. The Action has no access to
  AuthHero's bindings, database or environment.
- **`require` is not available.** `dependencies` can be stored on an Action, for
  compatibility with Auth0 exports, but they aren't installed or loaded. Use
  `fetch` instead of an SDK, or move the logic to a [config hook](./hooks.md#code-based-hooks).
- **Secrets** are available as `event.secrets.NAME`. Secret values are write-only
  in the Management API: responses only return the names. They can be
  [encrypted at rest](../security/encryption-at-rest.md).
- **`event.client`** contains `client_id`, `name` and `metadata` (the client's
  `client_metadata`).
- **Timeout:** AuthHero stops waiting for an Action after 5 seconds and discards
  the API calls it made. Outbound requests the Action already started are not
  cancelled.

## Triggers

| Trigger (Auth0 ID)                  | Handler export                          | Runs                                                       | Auth0 |
| ----------------------------------- | --------------------------------------- | ---------------------------------------------------------- | ----- |
| `post-login`                        | `onExecutePostLogin`                    | After the user authenticates, before tokens are issued      | ✅    |
| `credentials-exchange`              | `onExecuteCredentialsExchange`          | On every token issuance, for every grant (including refresh) | ✅¹   |
| `pre-user-registration`             | `onExecutePreUserRegistration`          | Just before a user is created                               | ✅    |
| `post-user-registration`            | `onExecutePostUserRegistration`         | After the user is created (via the outbox)                  | ✅    |
| `custom-email-provider`             | `onExecuteCustomEmailProvider`          | Instead of the tenant's email provider                      | ✅    |
| `custom-phone-provider`             | `onExecuteCustomPhoneProvider`          | Instead of the tenant's SMS provider                        | ✅    |
| `custom-token-exchange`             | `onExecuteCustomTokenExchange`          | When a Custom Token Exchange profile runs                   | ✅    |
| `validate-registration-username`    | `onExecuteValidateRegistrationUsername` | When an email is entered for signup, before the user exists | ❌    |
| `pre-user-update`                   | `onExecutePreUserUpdate`                | Before a user is updated                                    | ❌    |
| `post-user-update`                  | `onExecutePostUserUpdate`               | After a user is updated (via the outbox)                    | ❌    |
| `pre-user-deletion`                 | `onExecutePreUserDeletion`              | Before a user is deleted                                    | ❌    |
| `post-user-deletion`                | `onExecutePostUserDeletion`             | After a user is deleted (via the outbox)                    | ❌    |
| `pre-screen`                        | `onExecutePreScreen`                    | Before a universal-login screen is shown and when it is submitted | ❌ |

¹ In Auth0, `credentials-exchange` runs only for the client credentials grant.
In AuthHero it runs for every grant.

Internally, `post-login` is stored as `post-user-login`. Both IDs are accepted on
the trigger routes, and the internal ID is what you use with `POST /api/v2/hooks`.

`custom-token-exchange` is not bound through trigger bindings. A
[Custom Token Exchange](./custom-token-exchange.md) profile names the Action it
runs.

The ❌ triggers are AuthHero extensions. Each one has its own section in the hooks
guide: [registration validation](./hooks.md#registration-validation-actions),
[user update and deletion](./hooks.md#stored-user-lifecycle-actions) and
[`pre-screen`](./hooks.md#screen-action-pre-screen).

## The `api` object per trigger

| Trigger                          | Methods                                                                                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `post-login`                     | `accessToken.setCustomClaim(claim, value)`, `idToken.setCustomClaim(claim, value)`, `access.deny(reason)`, `user.setLinkedTo(userId)`, `users.ensure(params)`, `multifactor.enable(provider, options?)`. `redirect.sendUserTo` and `prompt.render` are declared but not supported yet (see below) |
| `credentials-exchange`           | `accessToken.setCustomClaim(claim, value)`, `idToken.setCustomClaim(claim, value)`, `access.deny(code, reason?)`                                               |
| `pre-user-registration`          | `user.setUserMetadata(key, value)`, `user.setAppMetadata(key, value)`, `user.setLinkedTo(userId)`, `users.ensure(params)`, `access.deny(code, reason?)`, `validation.error(code, message)` |
| `validate-registration-username` | `access.deny(reason?)`                                                                                                                                         |
| `pre-user-update`                | `access.deny(reason?)`                                                                                                                                         |
| `pre-user-deletion`              | `access.deny(reason?)`                                                                                                                                         |
| `pre-screen`                     | `redirect.sendUserTo(url, { query? })`, `access.deny(reason?)`                                                                                                 |
| `custom-email-provider`, `custom-phone-provider` | `notification.drop(reason?)`, `notification.retry(reason?)`, `notification.useDefaultProvider()`                                               |
| `custom-token-exchange`          | `authentication.setUserById(userId)`, `authentication.setUserByConnection(connection, attributes, options?)`, `access.deny(code, reason?)`, `access.rejectInvalidSubjectToken(reason?)` |
| `post-user-registration`, `post-user-update`, `post-user-deletion` | None. These triggers are for side effects; use `event.idempotency_key` to deduplicate them. |

::: warning Post-login Actions
- Claims set with `api.accessToken.setCustomClaim` and `api.idToken.setCustomClaim`
  are added to the tokens issued for that login, including the
  authorization-code exchange. Unlike Auth0, AuthHero doesn't run post-login
  Actions again on a refresh-token exchange, so refreshed tokens don't carry
  them. Set claims that must survive a refresh in a `credentials-exchange` Action.
- `api.redirect.sendUserTo` and `api.prompt.render` are not supported yet. The call
  is ignored and the execution records an `unsupported_api` error. To redirect or
  collect input after login, use a [form or page hook](./hooks.md#form-hooks), or
  a [`pre-screen`](./hooks.md#screen-action-pre-screen) Action before login.
:::

The exact TypeScript declarations for each trigger are generated from
`CodeHookApiByTrigger` in `@authhero/adapter-interfaces`. The admin editor and the
[Action generator](#generating-and-verifying-code) use them. These guides cover
specific APIs in more detail:

- [`api.users.ensure`](./hooks.md#anchoring-users-to-an-external-record-api-users-ensure) and `api.user.setLinkedTo`: [Account linking](../auth0-comparison/account-linking.md)
- `api.multifactor.enable`: [MFA](./mfa.md)
- `api.notification.*`: [Custom email and SMS providers](./custom-email-and-sms-providers.md)
- `api.authentication.*`: [Custom Token Exchange](./custom-token-exchange.md)

## Order of execution

Bindings on a trigger run one at a time, in descending `priority`. When you
replace a trigger's bindings with `PATCH /actions/triggers/{triggerId}/bindings`,
the first binding in the array gets the highest priority. Config hooks passed to
`init()` run before the stored Actions on the same trigger. Disabled bindings are
skipped.

## Errors and timeouts

What happens when an Action throws, times out, or can't run depends on the
trigger:

| Trigger                                                                    | Action throws, times out or can't run                                              | Explicit denial                                                              |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `validate-registration-username`, `pre-user-update`, `pre-user-deletion`   | **Fails closed**: the operation is refused. A missing executor also refuses it.    | Refused with HTTP 400                                                        |
| `credentials-exchange`                                                     | Fails open, unless the binding sets `metadata.fail_closed`                         | `api.access.deny(code, reason)`: 400, no tokens are signed, for every grant  |
| `post-login`                                                               | Fails open, unless the binding sets `metadata.fail_closed`                         | `api.access.deny(reason)`: 403 `access_denied`, the login session fails and a failed-login log (`f`) is written |
| `pre-user-registration`                                                    | Fails open, unless the binding sets `metadata.fail_closed`                         | `api.access.deny(code, reason)`: 400, the user is not created                |
| `pre-screen`                                                               | Showing a screen fails open unless the binding sets `metadata.fail_closed`; submitting always fails closed | `api.access.deny(reason)` stops the screen and shows the reason |
| `post-user-registration`, `post-user-update`, `post-user-deletion`         | Retried through the outbox, then dead-lettered; see [delivery](./hooks.md#delivery-for-post-registration-post-update-and-post-deletion-code-hooks) | No denial API                     |

A denial stores the execution as `canceled` and later Actions on the trigger
don't run. With `metadata.fail_closed: true`, a failing Action denies the request
with the reason `action_timeout` or `action_failed`; a binding whose Action can't
run at all (no code executor, or the Action was deleted) is denied too. See
[Denying a login and failing closed](./hooks.md#denying-a-login-and-failing-closed)
for an example.

Every failure is recorded on the execution record and logged as a `FAILED_HOOK`
log event.

## Managing Actions in the admin

- **Actions** lists the library. Create an Action by choosing its triggers and
  writing code, or [generate a draft](#generating-and-verifying-code). The edit
  screen has **Settings** (name, triggers, code, secrets), **Test**, **Versions**
  and **Raw JSON** tabs.
- **Triggers** shows every binding per trigger. Add a binding, enable it and set
  its priority.
- **Logs**: a log entry produced by a flow that ran Actions links to its
  execution, which shows each Action's status, error and console output.

## Management API

All routes are under `/api/v2/actions` and require the `read:actions`,
`create:actions`, `update:actions` or `delete:actions` scope.

### Actions

| Method   | Path                    | Description                                                                          |
| -------- | ----------------------- | ------------------------------------------------------------------------------------ |
| `GET`    | `/actions`              | List Actions. Supports `page`, `per_page`, `include_totals`, `q`, `sort` and checkpoint pagination (`from`, `take`) |
| `POST`   | `/actions`              | Create an Action (`name`, `code`, `supported_triggers`, `secrets`, `runtime`, `dependencies`) |
| `GET`    | `/actions/{id}`         | Get an Action. Secrets are returned without values                                   |
| `PATCH`  | `/actions/{id}`         | Update an Action. A secret sent without a `value` keeps its stored value             |
| `DELETE` | `/actions/{id}`         | Delete an Action                                                                     |
| `POST`   | `/actions/{id}/deploy`  | Deploy the current code and store it as a new version                                |
| `POST`   | `/actions/{id}/test`    | Run the Action against a sample event (see below)                                    |

### Versions

| Method | Path                                        | Description                                       |
| ------ | ------------------------------------------- | ------------------------------------------------- |
| `GET`  | `/actions/{actionId}/versions`              | List versions                                     |
| `GET`  | `/actions/{actionId}/versions/{id}`         | Get a version                                     |
| `POST` | `/actions/{actionId}/versions/{id}/deploy`  | Deploy an earlier version again (roll back)       |

### Trigger bindings

| Method  | Path                                    | Description                                       |
| ------- | --------------------------------------- | ------------------------------------------------- |
| `GET`   | `/triggers/{triggerId}/bindings`        | List the Actions bound to a trigger               |
| `PATCH` | `/triggers/{triggerId}/bindings`        | Replace all Action bindings on the trigger        |

```bash
curl -X PATCH "$AUTH_URL/api/v2/actions/triggers/credentials-exchange/bindings" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "bindings": [
      { "ref": { "type": "action_name", "value": "Add tier claim" } },
      { "ref": { "type": "action_id", "value": "act_123" } }
    ]
  }'
```

The PATCH replaces only Action bindings; webhooks, forms and templates on the
trigger are left alone. Options stored in a binding's `metadata`, such as
`screens` on `pre-screen` or `message_types` on the custom provider triggers,
are kept for Actions that stay bound. Auth0's binding body can't carry these
options, so set them with `POST /api/v2/hooks` or `PATCH /api/v2/hooks/{id}`. The
same routes enable or disable a single binding. Replacing is refused with 403 if
the trigger has an enforced binding synced from a parent tenant.

### Executions

| Method | Path                         | Description                                                         |
| ------ | ---------------------------- | ------------------------------------------------------------------- |
| `GET`  | `/executions/{id}`           | Auth0-shaped execution: `trigger_id`, `status` and per-Action `results` |
| `GET`  | `/executions/{id}/logs`      | AuthHero extension: the console output captured for each Action    |

The execution ID is written to the tenant log of the flow that ran the Actions as
`details.execution_id`, the same way Auth0 does. That covers successful logins,
token exchanges, signups and screens. Console output is capped at 256 characters
per execution and kept for 10 days by default. See
[Console output is persisted](./hooks.md#console-output-is-persisted) for the
limits and the `actionExecutionLogs` option.

### Testing an Action

`POST /actions/{id}/test` runs the stored code in the configured executor without
applying anything:

```bash
curl -X POST "$AUTH_URL/api/v2/actions/actions/act_123/test" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "trigger_id": "post-login", "event": { "user": { "email": "a@example.com" } } }'
```

The response contains `success`, `error`, `duration_ms`, the recorded `api_calls`
and the console `logs`. The Action's secrets are added to `event.secrets`. Without
a code executor the route returns 503.

## Generating and verifying code

The admin's create and edit screens can generate a draft Action from a prompt,
and verify code statically before it is saved. Generation is enabled by passing an
`ActionCodeGenerator` to `init()`; when it is enabled, the server also rejects
writes whose code fails verification. See
[Generate Actions from a prompt](./hooks.md#generate-actions-from-a-prompt) for
the setup, the models and the `/generation`, `/generate` and `/verify` routes.

## Sharing Actions across tenants

In a [multi-tenant](../customization/multi-tenancy/index.md) deployment, the
control-plane tenant can publish an Action as a shared template:

- Mark the control-plane Action with `is_system: true`.
- In a child tenant, create an Action with the same `name` and `inherit: true`
  (**Inherit to child tenants** in the admin). At execution time the code is read
  from the control-plane Action. Secrets merge by name, and the child tenant's own
  values win.

Inherited stubs only resolve while the tenant reads configuration from the
control plane; see the [config sync runbook](../customization/multi-tenancy/config-sync-migration.md).
To push an Action and its binding to every tenant instead, publish both with
`scope: "shared"` or `"platform"`, as described in
[Stored user lifecycle Actions](./hooks.md#stored-user-lifecycle-actions).

Actions, their versions and their bindings are included in
[tenant export and import](./tenant-export-import.md).

## Differences from Auth0

| Area                       | Auth0                                                     | AuthHero                                                                                           |
| -------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| npm dependencies           | Installed and loadable with `require`                      | Stored but not loaded; no `require`                                                                |
| `runtime`                  | Selects the Node.js version                               | Stored only. The executor decides the runtime                                                      |
| Timeout                    | 20 seconds                                                | 5 seconds                                                                                          |
| Console output             | 256 characters per Action                                  | 256 characters per execution, across all Actions                                                   |
| `credentials-exchange`     | Client credentials grant only                             | Every grant, including refresh tokens                                                              |
| `post-login` API           | Full API                                                   | Claims, deny, account linking and MFA. No `api.redirect`, `api.prompt`, `api.authentication`, `api.session`, `api.refreshToken`, `api.cache`, `api.samlResponse`, `api.user.setUserMetadata`/`setAppMetadata` or `api.accessToken.addScope` |
| Post-login on refresh      | Runs again on refresh-token exchanges                      | Doesn't run; claims from the login aren't re-applied on refresh                                    |
| Post-login deny            | Redirects to the client with `error=access_denied`          | Returns 403 `access_denied`                                                                        |
| `onContinuePostLogin`      | Supported                                                  | Not supported                                                                                      |
| Failing closed             | —                                                          | Opt-in per binding with `metadata.fail_closed`                                                     |
| `GET /actions/triggers`    | Lists the available triggers                               | Not implemented; see the [trigger table](#triggers)                                                |
| Other triggers             | `post-change-password`, `send-phone-message`, `password-reset-post-challenge` | Not available                                         |
| Extra triggers             | —                                                          | `validate-registration-username`, `pre-user-update`, `post-user-update`, `pre-user-deletion`, `post-user-deletion`, `pre-screen` |
| Console output API         | Real-time logs stream                                      | `GET /actions/executions/{id}/logs`                                                                |
