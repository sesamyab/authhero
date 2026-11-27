---
title: Hooks Guide
description: Comprehensive guide to AuthHero hooks including lifecycle, configuration options, code-based hooks, webhooks, form hooks, and page hooks.
---

# Hooks Guide

This guide explains how hooks work in AuthHero, including their lifecycle, configuration options, and usage patterns.

::: tip Looking for the design details?
The [Hooks & Outbox Pipeline](../architecture/hooks-pipeline.md) architecture doc explains the **why**: the three-phase execution model (prepare / commit / publish), transaction boundaries, outbox-based post-hook delivery, dead-letter, and self-healing. Start there if you are adding a new trigger or debugging a webhook that "never fired."
:::

## Overview

AuthHero provides a flexible hooks system that allows you to execute custom logic at key points in the authentication lifecycle. Hooks can be implemented as:

- **Code-based hooks**: Functions defined in your application code
- **Webhooks**: HTTP endpoints that receive hook events
- **Form hooks**: Redirect users to custom forms
- **Page hooks**: Redirect users to custom pages with permission checks

Actions store reusable JavaScript code. A hook connects an Action, webhook, form,
template, or page to a trigger. The admin Triggers page groups every binding type by
event. Add a binding to select an Action, webhook, form, template, or page, then
enable it and set its priority. Actions remain in the Actions library, where
you edit, test, and deploy their code. Binding types run in separate phases;
priority orders bindings within a type.

## Generate Actions from a prompt

The Actions create and edit screens can generate a draft with GLM, DeepSeek, or
Qwen. Choose a trigger and model, describe the action, review the preview, and
select **Use generated code**. Generation does not save or deploy the draft.

Enable generation by passing an `ActionCodeGenerator` adapter to `init`. Core
depends only on this small interface; Cloudflare integration lives in the
optional `@authhero/cloudflare-adapter` package and uses `fetch` without a provider SDK:

```typescript
import { init } from "authhero";
import { CloudflareActionCodeGenerator } from "@authhero/cloudflare-adapter";

const { app } = init({
  dataAdapter,
  actionCodeGenerator: new CloudflareActionCodeGenerator({
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    gatewayId: env.CLOUDFLARE_AI_GATEWAY_ID,
    apiToken: env.CLOUDFLARE_AI_API_TOKEN,
    // Optional: override individual model IDs as your deployment needs change.
    // models: { glm: "@cf/zai-org/glm-4.7-flash" },
  }),
});
```

Configure a Cloudflare API token with Workers AI access and access to the selected
models. Credentials stay on the server. The adapter uses Cloudflare's
[AI Gateway REST API](https://developers.cloudflare.com/ai-gateway/usage/rest-api/)
with the configured gateway ID. Defaults are
[`@cf/zai-org/glm-4.7-flash`](https://developers.cloudflare.com/workers-ai/models/glm-4.7-flash/),
[`@cf/deepseek-ai/deepseek-v4-flash-0731`](https://developers.cloudflare.com/workers-ai/models/deepseek-v4-flash-0731/), and
[`@cf/qwen/qwen3.8-27b`](https://developers.cloudflare.com/workers-ai/models/qwen3.8-27b/).
It requests that gateway logging and caching be skipped. The generation request
contains the user's prompt and trigger context; existing action code, events,
and stored secret values are not sent to the model. Users should describe secret
names in prompts and configure values in the Secrets section.

Each request also includes TypeScript declarations for the selected trigger's
`ActionAPI`, including parameter types, optional arguments, return types, and
referenced types such as token-exchange user attributes and options. These are
generated from the shared sandbox API types and committed as
`codeHookApiDeclarations.generated.json` in `@authhero/adapter-interfaces`
(see [Generated files](/contributing/development-setup#generated-files)). They describe only
methods available to code Actions; server-side hook helpers are excluded. The
model is instructed to use them as reference and still output plain JavaScript.

### Verifying Action code

**Verify code** checks JavaScript syntax, the exported handler for every selected
trigger, and direct `api.namespace.method(...)` calls against the runtime's
supported APIs. These static checks do not execute the script, check every possible
dynamic API call, or prove runtime behavior. Use the Test tab with representative
events for behavioral checks after saving.

Whether verification is required depends on the server:

|                                                                    | Generator configured                                                          | No generator                                                |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `GET /generation`                                                  | Lists the models, `verification_required: true`                               | No models, `verification_required: false`                   |
| Server writes (create, change code or triggers, deploy, roll back) | Rejected with `400 action_verification_failed` if the code fails verification | Accepted without verification, as before generation existed |
| Admin save                                                         | Verifies the submitted code first and shows the errors                        | Saves without verifying                                     |
| **Verify code** button and `POST /verify`                          | Available                                                                     | Available                                                   |

Rejected writes do not persist or deploy source. Create, update and deploy skip
inherited stubs with empty local code; nonempty local fallback code still needs
verification. Rolling back always verifies the version's code, including an empty
inherited stub.

Verification is only enforced together with generation because that's when
untrusted, model-written code is most likely to reach a save. Turning it on
everywhere would start rejecting writes from existing Management API
integrations whose code worked before the verifier existed, and the verifier
only allows API calls it can check statically. The admin repeats the server's
rule rather than verifying on every save, so it never blocks a save the server
would accept. It checks before sending the write so it can show the
verification errors next to the editor.

The admin reads `GET /generation` to decide. Servers older than authhero 9.28
don't have that route (or `/verify`). The admin treats a failed request as "no
generation": it hides the generator and saves without verifying, so a newer
admin still works against an older server.

The endpoints below are relative to `/api/v2/actions/actions` and require
`create:actions` or `update:actions`:

| Method | Path          | Request                                  | Result                                          |
| ------ | ------------- | ---------------------------------------- | ----------------------------------------------- |
| GET    | `/generation` | —                                        | Available model IDs and `verification_required` |
| POST   | `/generate`   | `{ prompt, model, trigger_id }`          | `{ code, verification: { valid, errors } }`     |
| POST   | `/verify`     | `{ code, supported_triggers: [{ id }] }` | `{ valid, errors }`                             |

Custom adapters implement `models` (a subset of `glm`, `deepseek`, `qwen`) and
`generate({ tenantId, prompt, triggerId, model, apiTypes }): Promise<{ code: string }>`. The
tenant ID lets an adapter select credentials or apply tenant-specific policy.
Core supplies `apiTypes` as trusted, trigger-specific TypeScript declarations;
custom generator adapters should include them in their model's instructions.

## Hook Lifecycle

### User Registration Flow

When a user signs up, the following hooks are triggered in order:

1. **Validate Registration Username** (`validateRegistrationUsername` / `onExecuteValidateRegistrationUsername`)
   - Runs when email is entered on identifier page (before user exists)
   - Checks if signup is allowed for this email
   - **Synchronous**: Blocks signup if validation fails
   - **Can modify**: Cannot modify user (no user exists yet)
   - Can be called on identifier page without creating a user

2. **Pre-User Registration** (`preUserRegistrationHook`)
   - Runs **RIGHT BEFORE** user creation
   - Executes for ALL signup methods (email/password, code, social, etc.)
   - **Synchronous**: Can block signup by throwing an exception
   - **Can modify**: Cannot modify user (not created yet)
   - Invokes `preUserRegistrationWebhook` if configured

3. **Pre-User Registration** (`onExecutePreUserRegistration`)
   - Code-based hook that runs just before user creation
   - **Synchronous**: Runs before DB insert
   - **Can modify**: Can set user metadata via `api.user.setUserMetadata()`
   - Has access to request context and token API

4. **User Creation**
   - User record is created in the database

5. **Account Linking** (`commitUserHook` + `account-linking` template)
   - Built-in path: when `userLinkingMode` resolves to `"builtin"` (the default), `commitUserHook` looks up an existing primary by verified email inside the commit transaction and sets `linked_to` atomically with the `rawCreate`.
   - Template path: any enabled `account-linking` template hook at `post-user-registration` runs after the commit. The template is a pre-defined function (not user code) — tenants enable it by creating a `TemplateHook` with `template_id: "account-linking"`. See [Account Linking](/auth0-comparison/account-linking) for the toggles.

6. **Post-User Registration** (`onExecutePostUserRegistration`)
   - Code-based hook that runs after user creation
   - **Asynchronous**: Errors are logged but don't block the flow
   - **Can modify**: Cannot modify user (already created)
   - Has access to created user and token API

7. **Post-User Registration Webhook** (`postUserRegistrationWebhook`)
   - HTTP webhook invoked after user creation
   - **Delivered via the outbox** — retried with exponential backoff, dead-lettered after `maxRetries` (see [Failed events](/customization/failed-events))
   - **Idempotent by contract**: each POST carries `Idempotency-Key: {event.id}` so retries dedupe on the receiving side
   - **Self-heals**: if delivery dead-letters, the user's next login re-enqueues the event until it succeeds
   - **Can modify**: Cannot modify user (already created)

### Registration validation Actions

Attach an Action to **Validate Registration Username** on the **Triggers** page,
or bind it through `PATCH /api/v2/actions/triggers/validate-registration-username/bindings`.
Select `validate-registration-username` when creating the Action and export:

```javascript
exports.onExecuteValidateRegistrationUsername = async (event, api) => {
  if (!event.user.email.endsWith("@example.com")) {
    api.access.deny("Registration requires an example.com email");
  }
};
```

The event includes `user.email`, `user.connection`, `client`, `tenant`, `request`,
and `secrets`. There is no user ID yet. Actions run synchronously in priority
order after the application-configured validation hook and before the validation
webhook. A denial or execution failure blocks registration and stops later
Actions. Results appear in Action executions. Disabled bindings are skipped.
Validation can run on the identifier page and again before user creation, so
Actions should tolerate repeated calls.

### User Login Flow

When a user logs in, the following hooks are triggered:

1. **User Authentication**
   - User credentials are verified

2. **Login Statistics Update**
   - `last_login`, `last_ip`, and `login_count` are updated

3. **Post-Login Code Hook** (`onExecutePostLogin`)
   - Code-based hook with Auth0-compatible API
   - **Synchronous**: Can modify authentication flow
   - **Can modify**: Can redirect users, render forms, modify tokens
   - Can access user, client, transaction, and session information

4. **Post-Login Form Hook**
   - If configured, redirects to custom form
   - **Synchronous**: User must complete form before continuing
   - **Can modify**: Form can collect additional data

5. **Post-Login Page Hook**
   - If configured, redirects to custom page
   - **Synchronous**: User must complete page flow
   - Can require specific permissions

6. **Post-Login Webhooks**
   - All enabled webhooks are invoked
   - **Asynchronous**: Errors are logged but don't block the flow
   - **Can modify**: Cannot modify user or tokens

### User Update Flow

When a user is updated via the Management API:

1. **Pre-User Update Hook** (`onExecutePreUserUpdate`)
   - Code-based hook that runs before update
   - **Synchronous**: Can block update by calling `api.cancel()`
   - **Can modify**: Can modify update data via `api.user.setUserMetadata()`
   - Has access to current user state and requested updates

2. **User Update**
   - User record is updated in database

3. **Email Verification Check** (built-in path, when enabled)
   - If `userLinkingMode` resolves to `"builtin"` (the default) and the update touched `email` or `email_verified`, the same in-transaction lookup as user creation runs and sets `linked_to` to a matching primary if one exists.

4. **Post-User-Update Template Hooks**
   - Any enabled `account-linking` template hook at `post-user-update` runs after the commit closes. Useful when a tenant has set `userLinkingMode: "off"` and wants linking driven entirely by the template at all three triggers (login, registration, update).

### User Deletion Flow

When a user is deleted:

1. **Pre-User Deletion Hook** (`onExecutePreUserDeletion`)
   - Code-based hook that runs before deletion
   - **Synchronous**: Can block deletion by calling `api.cancel()`
   - **Can modify**: Cannot modify user (will be deleted)
   - Has access to user data before deletion

2. **User Deletion**
   - User record is removed from database

3. **Post-User Deletion Hook** (`onExecutePostUserDeletion`)
   - Code-based hook that runs after successful deletion
   - **Asynchronous**: Errors are logged but don't prevent deletion
   - **Can modify**: Cannot modify user (already deleted)

## Stored user lifecycle Actions

In addition to callbacks supplied in `init({ hooks })`, Actions stored through
the Management API can bind to these user lifecycle triggers:

| Trigger              | Handler export              | Execution                           |
| -------------------- | --------------------------- | ----------------------------------- |
| `pre-user-update`    | `onExecutePreUserUpdate`    | Before the update; can deny         |
| `post-user-update`   | `onExecutePostUserUpdate`   | After commit; outbox delivery       |
| `pre-user-deletion`  | `onExecutePreUserDeletion`  | Before unlinking/deleting; can deny |
| `post-user-deletion` | `onExecutePostUserDeletion` | After commit; outbox delivery       |

Create an Action, then attach it under **Action Triggers** or with
`PATCH /api/v2/actions/triggers/{triggerId}/bindings`. A code hook created through
`POST /api/v2/hooks` with its `code_id` pointing to the Action also works. Enabled
Actions run in descending priority order. The configured pre callback runs
first, followed by stored pre Actions, before the database transaction starts.
Replacing a trigger's bindings is refused when it contains an enforced synced
binding; manage the tenant's local hooks individually instead.

```javascript
exports.onExecutePreUserDeletion = async (event, api) => {
  if (event.user.app_metadata?.deletion_protected) {
    api.access.deny("This account cannot be deleted yet.");
  }
};
```

Both pre triggers expose `api.access.deny(reason)`. A denial stops subsequent
Actions and returns HTTP 400 without committing the write. Execution errors,
timeouts, missing code, and a missing executor also stop the operation. The
host stops waiting for an Action after five seconds and discards late API calls;
it cannot terminate an executor's already-running external requests. The
existing configured callbacks retain their `api.cancel()` API. Stored pre
Actions inspect the proposed operation; they do not expose mutation APIs.

Each event includes `user`, `user_id`, `tenant.id`, request metadata and the
Action's `secrets`. Update events additionally include `previous_user` (the
snapshot before the update) and `updates` (the proposed or committed write
payload, including changes made by the configured pre-update callback).
Pre-update `user` is the previous snapshot; post-update `user` reflects that
write. The post-update snapshot precedes automatic account linking and
post-update template side effects. Internal bookkeeping and top-level password
fields are omitted from these payloads; live application context is never sent
to stored Actions.

Post Actions expose no mutation API and cannot undo an already committed write.
With the outbox enabled, their events commit atomically with the write and use
the existing retry/dead-letter machinery. Delivery is at least once: use
`event.idempotency_key` to deduplicate downstream side effects. Retries may run
earlier Actions and webhooks again. Without an outbox, post-update and
post-deletion Actions run best effort in background work, with no retries.
Executions, including denied and failed pre Actions, are recorded under the
existing Action execution logging settings.

These hooks apply to decorated user writes, including the Management API,
self-service account screens and SCIM. Internal writes that change only
`linked_to` bypass update hooks to prevent account-linking recursion. Direct
writes through raw adapters bypass lifecycle hooks.

For control-plane publishing, publish **both the Action and its hook binding**
with `scope: "shared"` or `"platform"`. Existing config sync copies the Action
and remaps its binding to the tenant's copy. Platform policies execute even
though tenant management APIs hide them. Fleet propagation still requires
synced descendants, the scheduled rollout driver and, for separate workers,
the configured sync transport. See [fleet rollouts](../customization/multi-tenancy/tenant-operations.md#fleet-rollouts-of-synced-config).

## Screen Action (`pre-screen`)

`pre-screen` is an **AuthHero extension**: Auth0 has no pre-login trigger
(its first login trigger, post-login, runs only after authentication). It runs
before a universal-login screen is shown (`event.transaction.phase` is
`"render"`) and again when the screen is submitted (`"submit"`), on the `/u2`
screens and on the classic `/u` pages that have the same screen. An Action can
send the user somewhere else or stop the screen. Only code Actions and the
`onExecutePreScreen` config callback can bind to it; URL, form and page hooks
can't.

Typical uses:

- Send users of a partner domain to their own identity provider right after
  they enter their email on `login-id` (submit phase, `event.user` is known).
- Send users whose identity lives elsewhere (for example users who sign in
  through [custom token exchange](./custom-token-exchange.md)) to that system
  instead of the account pages, or stop them from changing their email or
  deleting their account here.
- Block signup or password reset for a client or organization.

```javascript
exports.onExecutePreScreen = async (event, api) => {
  if (
    event.screen.name === "login-id" &&
    event.transaction.phase === "submit" &&
    event.user?.email?.endsWith("@partner.example")
  ) {
    api.redirect.sendUserTo("https://sso.partner.example/login", {
      query: { login_hint: event.user.email },
    });
  }
  if (event.operation === "delete-account") {
    api.access.deny("Contact support to close your account.");
  }
};
```

### Choosing screens

A binding chooses the screens it runs for in its hook `metadata.screens`
(the **Screens** picker on the binding in the admin UI). Empty or missing means
every screen, like `message_types` on the custom provider triggers. When nothing
is bound for a screen, nothing runs: the trigger reads the tenant's hook list,
which is served from the client bundle cache, and returns. The management API
rejects unknown screen names with a 400.

Screens use Auth0's Universal Login names (the prompt and screen names of
Advanced Customizations for Universal Login) where Auth0 has the screen. The
others are AuthHero-only:

| Screen (`event.screen.name`) | Prompt (`event.prompt.name`) | Auth0 name | Classic `/u` page | Submit `event.operation` | Description |
| --- | --- | --- | --- | --- | --- |
| `login-id` | `login-id` | ✅ | `/u/login/identifier` | — | Identifier step of identifier-first login |
| `login` | `login` | ✅ | — | — | Combined identifier and password login |
| `login-password` | `login-password` | ✅ | `/u/enter-password` | — | Password step after the identifier |
| `login-passwordless-identifier` | `login-passwordless` | — | — | — | Identifier step of a passwordless-only login |
| `login-passwordless-email-code` | `login-passwordless` | ✅ | `/u/login/email-otp-challenge` | — | Enter the code sent by email |
| `login-passwordless-sms-otp` | `login-passwordless` | ✅ | `/u/login/sms-otp-challenge` | — | Enter the code sent by text message |
| `magic-link-sent` | `login-passwordless` | — | — | — | Sign-in link sent by email |
| `passkey-challenge` | `passkeys` | — | — | — | Sign in with a passkey |
| `email-verification-code` | `email-verification` | — | — | — | Verify the email address with a code during login |
| `email-verification-link-sent` | `email-verification` | — | — | — | Verification link sent during login |
| `impersonate` | `impersonate` | — | `/u/impersonate` | — | Choose a user to impersonate |
| `signup` | `signup` | ✅ | `/u/signup` | — | Sign-up form |
| `reset-password-request` | `reset-password` | ✅ | `/u/forgot-password` | `reset-password` | Ask for a password reset |
| `reset-password-code` | `reset-password` | — | — | — | Enter the password reset code |
| `reset-password` | `reset-password` | ✅ | `/u/reset-password` | `reset-password` | Choose a new password |
| `mfa-login-options` | `mfa` | ✅ | — | — | Choose an MFA method |
| `mfa-otp-challenge` | `mfa-otp` | ✅ | — | — | Enter an authenticator app code |
| `mfa-otp-enrollment-qr` | `mfa-otp` | ✅ | — | — | Enroll an authenticator app |
| `mfa-phone-challenge` | `mfa-phone` | ✅ | — | — | Enter a code sent to the phone |
| `mfa-phone-enrollment` | `mfa-phone` | ✅ | — | — | Enroll a phone number |
| `passkey-enrollment` | `passkeys` | ✅ | — | — | Create a passkey |
| `passkey-enrollment-nudge` | `passkeys` | — | — | — | Offer to create a passkey after login |
| `consent` | `consent` | ✅ | — | — | Consent to the requested scopes |
| `device-code-activation` | `device-flow` | ✅ | — | — | Enter the device code |
| `device-code-confirmation` | `device-flow` | ✅ | — | — | Confirm the device |
| `device-code-activation-allowed` | `device-flow` | ✅ | — | — | Device activated |
| `accept-invitation` | `invitation` | ✅ | — | — | Accept an organization invitation |
| `account` | `account` | — | `/u/account` | `unlink-identity` on classic `/u/account` | Account overview |
| `account-profile` | `account` | — | — | `update-profile` | Edit profile |
| `account-change-email` | `account` | — | `/u/account/change-email` | `change-email` | Change email address |
| `account-change-email-verify` | `account` | — | `/u/account/change-email-verify` | — | Verify the new email address |
| `account-security` | `account` | — | — | `remove-mfa` or `remove-passkey` (`details.enrollment_id`, `details.type`) | MFA factors (remove a factor) |
| `account-mfa-totp-enrollment` | `account` | — | — | `enroll-mfa` (`details.factor: "totp"`) | Enroll an authenticator app from the account page |
| `account-mfa-phone-enrollment` | `account` | — | — | `enroll-mfa` (`details.factor: "phone"`) | Enroll a phone from the account page |
| `account-linked` | `account` | — | — | `unlink-identity` (`details.provider`, `details.user_id`) | Linked identities (unlink an identity) |
| `account-passkeys` | `account` | — | — | `enroll-passkey` (start and completion), `remove-passkey` (`details.enrollment_id`) | Passkeys (add or remove a passkey) |
| `account-delete` | `account` | — | — | `delete-account` | Delete the account |
| `connect-consent` | `connect` | — | — | — | Approve connecting an application |
| `connect-tenant-select` | `connect` | — | — | — | Choose the tenant to connect |
| `self-service-app` | `self-service` | — | — | — | Self-service application setup |
| `invalid-session` | `status` | — | `/u/invalid-session` | — | Login session expired or invalid |
| `try-connection-result` | `status` | — | — | — | Result of testing a connection |

`impersonate`, `device-*`, `connect-*`, `self-service-app`, `invalid-session`
and `try-connection-result` fire like every other screen. Whatever screen a
submission answers with directly fires `render` too: the next step (the
identifier step answering with the password, code or link-sent screen) or the
same screen again with an error or success message.

### Event and API

- **`event.screen.name`, `event.prompt.name`**: from the table above.
- **`event.transaction`**: `phase`, and the authorization request: `client_id`,
  `redirect_uri`, `requested_scopes`, `response_type`, `response_mode`, `state`
  (the application's), `audience`, `prompt`, `ui_locales`, `locale`,
  `acr_values`, `login_hint` (the identifier entered so far) and `screen_hint`.
- **`event.user`** when known: the signed-in user on account screens, the user
  the entered identifier (email, phone number or username) belongs to on login,
  signup and password-reset screens (in the submit phase of `login-id`,
  `login`, `login-passwordless-identifier`, `signup` and
  `reset-password-request`, the identifier just submitted), the authenticated
  user on MFA, consent and passkey screens. On other screens a submitted form
  can't choose `event.user`.
  Undefined otherwise. `event.connection` is the user's primary identity.
- **`event.operation`** (submit phase only): what the submission does, with
  operation-specific `event.details`. See the table above.
- **`event.client`**, **`event.organization`** (`id`, `name`, `display_name`,
  `metadata` when the request names an organization), **`event.tenant.id`**,
  **`event.request`** and the Action's `secrets`.
- **`api.redirect.sendUserTo(url, { query })`** sends the user to `url` (http or
  https; relative URLs resolve against the current request). Only the URL and
  query the Action passes are used, nothing from the request, so the trigger
  can't be turned into an open redirect. No `state` is appended: the login
  session stays as it was and can be resumed with its URL until it expires; a
  submission that was redirected never reached the screen.
- **`api.access.deny(reason)`** stops the screen or submission and shows
  `reason` on the error page (or as the JSON error of the screen API).
- Doing nothing lets the screen continue.

### Ordering and failures

- The `onExecutePreScreen` config callback runs first, then bound Actions in
  descending priority. The first one that redirects or denies decides, and
  later ones don't run.
- **Submit fails closed**: an Action that throws, times out or redirects to an
  invalid URL denies the submission with a generic message, so a direct POST
  can't skip a denial.
- **Render fails open**: the failure is logged (`fh`) and the screen is shown.
  Set `metadata.fail_closed: true` on a binding (**Block the screen if the
  action fails while rendering** in the admin UI) to deny instead.
- Executions are recorded like other Actions; denials are logged as `fh`
  (`pre-screen denied render of account-delete`). The config callback gets the
  same five-second limit as code Actions; calls it makes after that are ignored.
- An Action can run twice for one step (render and submit), so keep it free of
  side effects.
- **Enumeration:** on login, signup and password-reset screens `event.user`
  reflects whether an account exists. If an Action only redirects or denies
  some users, the visible difference reveals that, so prefer rules that don't
  depend on the user there.
- **Not an enforcement point:** the trigger controls the interactive screens
  only. To guarantee a change is never accepted (including through the
  Management API), also deny it in `pre-user-update` or `pre-user-deletion`.

### Replaces `pre-account-action`

`pre-screen` replaces the `pre-account-action` trigger, which was removed.
Its operations are `event.operation` in the submit phase; to keep its behaviour,
select the account screens, `reset-password-request` and `reset-password`, and
check `event.operation`. The management API refuses `pre-account-action` with a
400; hooks still stored with it are ignored, and tenant imports and multi-tenancy
syncs skip them with a log line.

### Open follow-ups

- **Account-page direct links**: deep links into a single account screen
  (`/account?screen_hint=...` only covers change email today).
- **Form and flow bindings**: forms and flows can't bind to `pre-screen` yet;
  only code Actions and the config callback can.
- **State opt-in for custom redirect URLs**: a binding option to append the
  transaction `state` to the redirect so a custom page can send the user back
  into the same login.
- **Field prefill**: an API to prefill fields of the screen.

## Anchoring users to an external record (`api.users.ensure`)

`api.users.ensure` is an **AuthHero extension**. It lets a code Action create or
update a user that stands for a record in another system, such as a member in a
CRM or a membership register, and link every way a person signs in (email, SMS,
Vipps, Google…) under it. That user is the cluster's primary: tokens carry its
`user_id` as `sub` and its profile, but nobody ever signs in to it directly.

It works in `pre-user-registration` and `post-user-login`, together with
`api.user.setLinkedTo`:

```javascript
exports.onExecutePostLogin = async (event, api) => {
  const member = await lookupMember(event.user.email, event.secrets);
  if (!member) return;

  api.users.ensure({
    connection: "parat", // an `external` connection, see below
    id: String(member.id), // the user_id becomes "parat|<id>"
    profile: { email: member.email, given_name: member.firstName },
    app_metadata: { roles: member.roles },
  });
  api.user.setLinkedTo(`parat|${member.id}`);
};
```

**The `external` connection.** Users can only be ensured in a connection with
`strategy: "external"` and `options.allow_action_users: true`. It is not a way to
sign in: it never shows on login screens, `/authorize?connection=` treats it as
unknown, and it stores no credentials (keep the external system's API secrets in
the Action's secrets). Names that clash with a prefix login identities use are
refused: built-in providers (`email`, `sms`, `auth0`, `google-oauth2`…),
strategies injected through `env.STRATEGIES`, and the strategy of any of the
tenant's login connections. Create one through the Management API:

```http
POST /api/v2/connections
{ "name": "parat", "strategy": "external", "options": { "allow_action_users": true } }
```

**What `ensure` does.** Calls are applied after the Action returns, so `ensure`
returns nothing. You choose the id, and the call is an upsert:

- If `<connection>|<id>` doesn't exist, it is created with the profile and
  `app_metadata`. Otherwise non-blank profile fields overwrite the stored ones
  and `app_metadata` is shallow-merged. A new `email` without
  `email_verified` is stored as unverified.
- `id` is used exactly as given (no trimming), so pass the same string to
  `setLinkedTo`.
- The write bypasses user hooks: no `pre-user-registration`, no update hooks, no
  automatic email linking and no post-registration webhook. The user is a
  record, not a signup.
- Accepted profile fields: `email`, `email_verified`, `phone_number`, `name`,
  `given_name`, `family_name`, `nickname`, `picture`. Others are ignored.
- At most 5 calls per execution. A refused call writes nothing and logs a
  `Failed Hook` (`fh`) entry whose `details.reason` is `connection_not_allowed`,
  `invalid_id` (empty or containing `|`), `invalid_params` or `too_many_users`.

**How `setLinkedTo` treats these users.**

- In `pre-user-registration`, the new user is created linked to the target. If
  the target doesn't exist when the hooks finish, the user is registered
  unlinked and a `Failed Hook` entry with reason `primary_not_found` is logged.
- In `post-user-login`, a user ensured earlier in the same execution is a valid
  target, alongside `event.link_candidates`. The verified-email check doesn't
  apply to it: your Action matched the person against its own records.
- A primary in an `external` connection always stays primary, whatever the
  account ages. If the user signing in already has linked identities, they all
  move under it, and the token for this login is issued for it.
- A user already under one external primary is never moved to another by a
  login (reason `already_anchored`). Moving a person between records is an
  admin operation: use the Management API's unlink and link endpoints.

Automatic email linking doesn't know about external primaries yet. If an
**older, unlinked** user later verifies the same email address as an external
primary, the built-in email linking can still link the two in the older user's
favour. A user the Action has linked is excluded from built-in email linking,
but users it hasn't linked (including accounts that never sign in through it)
stay eligible, so an older unlinked account can still demote an external
primary. If your external primaries must stay stable, turn built-in linking off
with `userLinkingMode: "off"` (or `user_linking_mode: "off"` on the client) and
link users explicitly. See #1806 and the follow-ups on #1802.

## Custom email and phone provider Actions

The Auth0 triggers `custom-email-provider` and `custom-phone-provider` let a
code Action deliver outgoing emails and text messages (one-time codes, magic
links, verification and reset emails, MFA SMS) instead of the tenant's
provider. They have their own page:
[Custom Email and SMS Providers](./custom-email-and-sms-providers.md).

## Entity Hooks

In addition to user lifecycle hooks, AuthHero provides entity hooks that allow you to execute custom logic when management entities (roles, connections, resource servers, and role permissions) are created, updated, deleted, or modified.

### Overview

Entity hooks work at the data adapter layer, ensuring they fire regardless of which code path calls the adapter (REST API, internal code, etc.). This is similar to how caching works in AuthHero.

Available entity types:

- **Roles**: `beforeCreate`, `afterCreate`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`
- **Connections**: `beforeCreate`, `afterCreate`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`
- **Resource Servers**: `beforeCreate`, `afterCreate`, `beforeUpdate`, `afterUpdate`, `beforeDelete`, `afterDelete`
- **Role Permissions**: `beforeAssign`, `afterAssign`, `beforeRemove`, `afterRemove`

### Configuration

Entity hooks are configured during AuthHero initialization. Each entity type accepts an **array of hook objects**, allowing you to chain multiple hook handlers together:

```typescript
const authhero = new AuthHero({
  // ... other config
  entityHooks: {
    roles: [
      {
        beforeCreate: async (context, insert) => {
          console.log(`Creating role: ${insert.name}`);
          // Validate or modify the insert data
          return insert;
        },
        afterCreate: async (context, entity) => {
          console.log(`Role created: ${entity.name} (${entity.id})`);
          // Perform post-creation tasks (e.g., audit logging)
        },
        beforeUpdate: async (context, id, update) => {
          console.log(`Updating role ${id}`);
          // Validate or modify the update data
          return update;
        },
        afterUpdate: async (context, entity) => {
          console.log(`Role updated: ${entity.name}`);
        },
        beforeDelete: async (context, id) => {
          console.log(`Deleting role ${id}`);
          // Validate deletion or cleanup
        },
        afterDelete: async (context, id) => {
          console.log(`Role deleted: ${id}`);
          // Perform post-deletion cleanup
        },
      },
    ],
    connections: [
      {
        beforeCreate: async (context, insert) => {
          // Validate connection settings
          return insert;
        },
        afterCreate: async (context, entity) => {
          // Sync to external systems
        },
        // ... other hooks
      },
    ],
    resourceServers: [
      {
        beforeCreate: async (context, insert) => {
          // Validate resource server configuration
          return insert;
        },
        afterCreate: async (context, entity) => {
          // Initialize default permissions
        },
        // ... other hooks
      },
    ],
    rolePermissions: [
      {
        beforeAssign: async (context, roleId, permissions) => {
          console.log(`Assigning permissions to role ${roleId}`);
          // Validate permissions before assignment
          return permissions;
        },
        afterAssign: async (context, roleId, permissions) => {
          console.log(`Permissions assigned to role ${roleId}`);
          // Sync role security to external systems (e.g., resource servers)
        },
        beforeRemove: async (context, roleId, permissionIds) => {
          console.log(`Removing permissions from role ${roleId}`);
          // Validate permission removal
          return permissionIds;
        },
        afterRemove: async (context, roleId, permissionIds) => {
          console.log(`Permissions removed from role ${roleId}`);
          // Update external systems
        },
      },
    ],
  },
});
```

### Hook Context

All entity hooks receive a context object with the tenant information:

```typescript
interface EntityHookContext {
  tenantId: string;
}
```

### Hook Signatures

#### CRUD Entity Hooks (Roles, Connections, Resource Servers)

```typescript
interface EntityHooks<TEntity, TInsert, TUpdate> {
  beforeCreate?: (
    context: EntityHookContext,
    insert: TInsert,
  ) => Promise<TInsert>;

  afterCreate?: (context: EntityHookContext, entity: TEntity) => Promise<void>;

  beforeUpdate?: (
    context: EntityHookContext,
    id: string,
    update: TUpdate,
  ) => Promise<TUpdate>;

  afterUpdate?: (context: EntityHookContext, entity: TEntity) => Promise<void>;

  beforeDelete?: (context: EntityHookContext, id: string) => Promise<void>;

  afterDelete?: (context: EntityHookContext, id: string) => Promise<void>;
}
```

#### Role Permission Hooks

```typescript
interface RolePermissionHooks {
  beforeAssign?: (
    context: EntityHookContext,
    roleId: string,
    permissions: Array<{
      permission_name: string;
      resource_server_identifier: string;
    }>,
  ) => Promise<
    Array<{ permission_name: string; resource_server_identifier: string }>
  >;

  afterAssign?: (
    context: EntityHookContext,
    roleId: string,
    permissions: Array<{
      permission_name: string;
      resource_server_identifier: string;
    }>,
  ) => Promise<void>;

  beforeRemove?: (
    context: EntityHookContext,
    roleId: string,
    permissionIds: string[],
  ) => Promise<string[]>;

  afterRemove?: (
    context: EntityHookContext,
    roleId: string,
    permissionIds: string[],
  ) => Promise<void>;
}
```

### Use Cases

#### Sync Role Permissions to Resource Servers

````typescript
rolePermissions: [
  {
    afterAssign: async (context, roleId, permissions) => {
      // Get role details
      const role = await dataAdapter.roles.get(context.tenantId, roleId);

      // For each unique resource server, sync the role's permissions
      const resourceServers = new Set(
        permissions.map(p => p.resource_server_identifier)
      );

      for (const identifier of resourceServers) {
        const rolePermissions = permissions
          .filter(p => p.resource_server_identifier === identifier)
          .map(p => p.permission_name);

        // Sync to external resource server
        await fetch(`https://${identifier}/api/roles/${role.name}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ permissions: rolePermissions })
        });
      }
    },
    afterRemove: async (context, roleId, permissionIds) => {
      // Similar logic to remove permissions from resource servers
    },
  },
],

#### Audit Logging for Role Changes

```typescript
roles: [
  {
    afterCreate: async (context, entity) => {
      await auditLog.log({
        tenantId: context.tenantId,
        action: 'role.created',
        resourceType: 'role',
        resourceId: entity.id,
        details: { name: entity.name, description: entity.description }
      });
    },
    afterUpdate: async (context, entity) => {
      await auditLog.log({
        tenantId: context.tenantId,
        action: 'role.updated',
        resourceType: 'role',
        resourceId: entity.id,
        details: { name: entity.name }
      });
    },
    afterDelete: async (context, id) => {
      await auditLog.log({
        tenantId: context.tenantId,
        action: 'role.deleted',
        resourceType: 'role',
        resourceId: id
      });
    },
  },
],
````

#### Validate Connection Settings

```typescript
connections: [
  {
    beforeCreate: async (context, insert) => {
      // Validate required fields based on connection type
    if (insert.strategy === 'auth0' && !insert.options?.client_id) {
      throw new Error('Auth0 connections require a client_id');
    }
    return insert;
  },
  beforeUpdate: async (context, id, update) => {
    // Ensure critical settings aren't removed
    if (update.enabled_clients !== undefined && update.enabled_clients.length === 0) {
      throw new Error('Connection must have at least one enabled client');
    }
    return update;
  },
  },
],
```

#### Initialize Default Permissions for Resource Servers

```typescript
resourceServers: [
  {
    afterCreate: async (context, entity) => {
      // Create default permissions for new resource server
    const defaultPermissions = [
      { value: "read:all", description: "Read all resources" },
      { value: "write:all", description: "Write all resources" },
      { value: "delete:all", description: "Delete all resources" },
    ];

    for (const permission of defaultPermissions) {
      await dataAdapter.permissions.create(context.tenantId, {
        resource_server_id: entity.id,
        ...permission,
      });
    }
  },
  },
],
```

### Differences from User Lifecycle Hooks

| Aspect          | User Lifecycle Hooks                                                | Entity Hooks                                                             |
| --------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Purpose**     | Control authentication and user management flows                    | Manage configuration entities (roles, connections, etc.)                 |
| **Layer**       | Application layer (routes, authentication flow)                     | Data adapter layer                                                       |
| **Synchronous** | Mixed (some block flow, some are async)                             | All `before*` hooks can modify data, `after*` hooks are for side effects |
| **Can Modify**  | Limited (via API methods like `api.user.setUserMetadata()`)         | `before*` hooks return modified data directly                            |
| **Blocking**    | Some hooks can deny operations (e.g., `api.deny()`, `api.cancel()`) | Throw errors in `before*` hooks to block operations                      |
| **Webhooks**    | Supported                                                           | Not supported (code-based only)                                          |

## Hook Types

### Code-Based Hooks

Code-based hooks are functions defined in your application initialization:

```typescript
const authhero = new AuthHero({
  hooks: {
    onExecuteValidateRegistrationUsername: async (event, api) => {
      // Validate if email is allowed to sign up
      if (event.user.email.endsWith("@competitor.com")) {
        api.deny("Signups from this domain are not allowed");
      }

      // Or use token API for external validation
      const token = await api.token.createServiceToken({
        scope: "read:users",
        expiresInSeconds: 300,
      });
    },

    onExecutePostLogin: async (event, api) => {
      // Access user, client, and request information
      console.log(`User ${event.user.email} logged in`);

      // Modify authentication flow
      if (event.user.email.endsWith("@external.com")) {
        api.redirect.sendUserTo("https://external-idp.com/verify", {
          query: { email: event.user.email },
        });
      }

      // Create service tokens for API calls
      const token = await api.token.createServiceToken({
        scope: "read:users",
        expiresInSeconds: 300,
      });
    },

    onExecutePreUserRegistration: async (event, api) => {
      // Set custom user metadata
      await api.user.setUserMetadata("signup_date", new Date().toISOString());
      await api.user.setUserMetadata("signup_ip", event.request.ip);
    },

    onExecutePostUserRegistration: async (event, api) => {
      // Perform post-registration tasks
      console.log(`New user registered: ${event.user.email}`);
    },

    onExecutePreUserUpdate: async (event, api) => {
      // Validate or modify updates
      if (
        event.updates.email &&
        !event.updates.email.endsWith("@company.com")
      ) {
        api.cancel(); // Blocks the update
      }

      // Add additional metadata
      await api.user.setUserMetadata("last_updated_by", "admin");
    },

    onExecutePreUserDeletion: async (event, api) => {
      // Cleanup or validation before deletion
      if (event.user.app_metadata?.protected) {
        api.cancel();
      }
    },

    onExecutePostUserDeletion: async (event, api) => {
      // Cleanup after deletion
      console.log(`User ${event.user_id} was deleted`);
    },
  },
});
```

### Webhooks

Webhooks are HTTP endpoints that receive POST requests when hooks trigger:

**Request Format:**

```json
{
  "tenant_id": "tenant_123",
  "user": {
    "user_id": "auth0|123",
    "email": "user@example.com",
    ...
  },
  "trigger_id": "post-user-login"
}
```

**Response Format (for validation hooks):**

```json
{
  "allowed": false,
  "reason": "Optional denial reason"
}
```

**Configuration via Management API:**

```bash
POST /api/v2/hooks
{
  "name": "Post-Login Webhook",
  "trigger_id": "post-user-login",
  "url": "https://api.example.com/hooks/post-login",
  "enabled": true
}
```

#### Custom Webhook Invoker

By default, AuthHero invokes webhooks with a `POST` request containing a JSON body and a `Bearer` token generated by the built-in service token creator. You can replace this behavior entirely by providing a `webhookInvoker` function in the AuthHero configuration.

This is useful when you need to:

- Format the request body differently (e.g., wrap the payload in an envelope)
- Use your own authentication mechanism (API keys, HMAC signatures, etc.)
- Add custom headers or logging
- Route webhooks through a proxy or message queue

**Configuration:**

```typescript
import { init } from "authhero";

const { app } = init({
  dataAdapter,
  webhookInvoker: async ({ hook, data, tenant_id, createServiceToken }) => {
    // Use the built-in service token, or replace with your own auth
    const token = await createServiceToken();

    return fetch(hook.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Tenant-Id": tenant_id,
      },
      body: JSON.stringify({
        event: data.trigger_id,
        timestamp: new Date().toISOString(),
        payload: data,
      }),
    });
  },
});
```

**Parameters:**

The `webhookInvoker` function receives a single object with these properties:

| Parameter            | Type                                  | Description                                                                                     |
| -------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `hook`               | `Hook`                                | The hook being invoked (contains `url`, `hook_id`, `trigger_id`, etc.)                          |
| `data`               | `Record<string, unknown>`             | The payload data for the webhook                                                                |
| `tenant_id`          | `string`                              | The tenant ID                                                                                   |
| `createServiceToken` | `(scope?: string) => Promise<string>` | Lazily creates a service token. Only generates the token when called — no overhead if not used. |

The function must return a `Response` object. If the response status is >= 400, the webhook invocation will be logged as failed.

**Example: Using an API key instead of a service token:**

```typescript
const { app } = init({
  dataAdapter,
  webhookInvoker: async ({ hook, data }) => {
    return fetch(hook.url, {
      method: "POST",
      headers: {
        "X-API-Key": process.env.WEBHOOK_API_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });
  },
});
```

### Form Hooks

Form hooks redirect users to custom forms during the authentication flow:

```bash
POST /api/v2/hooks
{
  "name": "MFA Enrollment Form",
  "trigger_id": "post-user-login",
  "form_id": "form_abc123",
  "enabled": true
}
```

When triggered:

1. User is redirected to the form with state parameter
2. Form can access user context and login session
3. User completes form and is redirected back to authentication flow

### Page Hooks

Page hooks redirect users to custom pages with optional permission requirements:

```bash
POST /api/v2/hooks
{
  "name": "Terms Acceptance Page",
  "trigger_id": "post-user-login",
  "page_id": "page_xyz789",
  "permission_required": "accept:terms",
  "enabled": true
}
```

Features:

- Can require specific permissions before allowing access
- User context is passed to the page
- Supports redirect back to authentication flow

## Configuration

### Via Code (Initialization)

Pass hooks during AuthHero initialization:

```typescript
const authhero = new AuthHero({
  // ... other config
  hooks: {
    onExecuteValidateRegistrationUsername: async (event, api) => {
      /* ... */
    },
    onExecutePostLogin: async (event, api) => {
      /* ... */
    },
    onExecutePreUserRegistration: async (event, api) => {
      /* ... */
    },
    // ... other hooks
  },
});
```

### Via Management API

Create, update, or delete hooks using the Management API:

```bash
# Create a webhook hook
POST /api/v2/hooks
Authorization: Bearer {management_token}
Content-Type: application/json

{
  "name": "My Post-Login Hook",
  "trigger_id": "post-user-login",
  "url": "https://api.example.com/hooks/post-login",
  "enabled": true
}

# Create a form hook
POST /api/v2/hooks
{
  "name": "MFA Enrollment",
  "trigger_id": "post-user-login",
  "form_id": "form_123",
  "enabled": true
}

# List hooks
GET /api/v2/hooks?trigger_id=post-user-login

# Update hook
PATCH /api/v2/hooks/{hook_id}
{
  "enabled": false
}

# Delete hook
DELETE /api/v2/hooks/{hook_id}
```

## Available Hooks

### Validation Hooks

#### `onExecuteValidateRegistrationUsername`

Validates if an email can be used for signup.

**When it runs**: On identifier page when user enters email (before user exists)

**Synchronous**: Yes - blocks signup if denied

**Can modify user**: No (user doesn't exist yet)

**Event Payload**:

````

```typescript
{
  ctx: Context,              // Request context
  client: EnrichedClient,    // Client configuration with tenant and connections
  request: HookRequest,      // HTTP request details
  tenant: { id: string },
  user: {
    email: string,           // Email being validated
    connection: string       // Connection type (email, phone, etc.)
  }
}
````

**API Object**:

```typescript
{
  deny: (reason?: string) => void,  // Deny signup with optional reason
  token: {
    createServiceToken: (params: {
      scope: string,
      clientId?: string,                       // Optional: mint a grant-bounded token for a DB-registered M2M client
      audience?: string,                       // Used only when `clientId` is set (must match a granted audience)
      expiresInSeconds?: number,
      customClaims?: Record<string, unknown>
    }) => Promise<string>
  }
}
```

**Webhook Response** (if applicable):

```json
{
  "allowed": boolean,
  "reason": "Optional denial reason"
}
```

### Registration Hooks

#### `onExecutePreUserRegistration`

Runs before user creation, can modify user metadata.

**When it runs**: Just before user is created in database

**Synchronous**: Yes - runs before DB insert

**Can modify user**: Yes - via `api.user.setUserMetadata()`

**Event Payload**:

```typescript
{
  ctx: Context,
  user: User,                // User being created (minimal data)
  client: EnrichedClient,    // Client configuration with tenant and connections
  request: HookRequest,
  tenant: { id: string }
}
```

**API Object**:

```typescript
{
  user: {
    setUserMetadata: (key: string, value: any) => void
  },
  token: TokenAPI
}
```

#### `onExecutePostUserRegistration`

Runs after user creation for post-registration tasks.

**When it runs**: After user is created in database

**Synchronous**: No - errors are logged but don't block flow

**Can modify user**: No (already created)

**Event Payload**:

```typescript
{
  ctx: Context,
  user: User,                // Newly created user (full data)
  client: EnrichedClient,    // Client configuration with tenant and connections
  request: HookRequest,
  tenant: { id: string }
}
```

**API Object**:

```typescript
{
  user: {},                  // Empty object (no modification allowed)
  token: TokenAPI
}
```

### Login Hooks

#### `onExecutePostLogin`

Modifies authentication flow, tokens, or redirects users.

**When it runs**: After user authentication, before token issuance

**Synchronous**: Yes - can modify flow

**Can modify user**: Yes - indirectly via redirects/forms

**Event Payload** (Auth0-compatible):

```typescript
{
  user: User,
  client: Client,
  request: {
    ip: string,
    user_agent: string,
    url: string, // Original /authorize URL when a login session has one
    geoip: {
      countryCode: string,
      // ... other geo fields
    }
  },
  transaction: {
    id: string,
    locale: string,
    redirect_uri: string,
    // ... other transaction fields
  },
  authentication: {
    methods: Array<{
      name: string,
      timestamp: string
    }>
  },
  authorization: {
    roles: string[]
  },
  connection: {
    id: string,
    name: string,
    strategy: string
  },
  organization?: {
    id: string,
    name: string,
    display_name: string
  },
  // ... other Auth0-compatible fields
}
```

For login attribution, add UTM parameters to the `/authorize` URL and read them
from `event.request.url` in an `onExecutePostLogin` or post-login code hook:

```typescript
const authorizeUrl = new URL(event.request.url);
const utmSource = authorizeUrl.searchParams.get("utm_source");
const utmCampaign = authorizeUrl.searchParams.get("utm_campaign");
```

Post-login webhooks receive the same URL in `request.url`. When there is no
stored authorization URL, hooks receive the current request URL instead.

**API Object**:

```typescript
{
  prompt: {
    render: (formId: string) => void
  },
  redirect: {
    sendUserTo: (url: string, options?: {
      query?: Record<string, string>
    }) => void,
    encodeToken: (options: {
      secret: string,
      payload: Record<string, any>,
      expiresInSeconds?: number
    }) => string,
    validateToken: (options: {
      secret: string,
      tokenParameterName?: string
    }) => Record<string, any> | null
  },
  token: TokenAPI
}
```

### User Management Hooks

#### `onExecutePreUserUpdate`

Validates or modifies user updates before they're applied.

**When it runs**: Before user update is written to database

**Synchronous**: Yes - can block update

**Can modify user**: Yes - can modify update data

**Event Payload**:

```typescript
{
  ctx: Context,
  tenant: { id: string },
  user_id: string,
  user: User,                // Current user state
  updates: Partial<User>,    // Requested changes
  request: HookRequest
}
```

**API Object**:

```typescript
{
  user: {
    setUserMetadata: (key: string, value: any) => void
  },
  cancel: () => void,        // Blocks the update
  token: TokenAPI
}
```

#### `onExecutePreUserDeletion`

Validates before user deletion.

**When it runs**: Before user is deleted from database

**Synchronous**: Yes - can block deletion

**Can modify user**: No (will be deleted)

**Event Payload**:

```typescript
{
  ctx: Context,
  user: User,                // User before deletion
  user_id: string,
  request: HookRequest,
  tenant: { id: string }
}
```

**API Object**:

```typescript
{
  cancel: () => void,        // Blocks the deletion
  token: TokenAPI
}
```

#### `onExecutePostUserDeletion`

Cleanup after user deletion.

**When it runs**: After user is deleted from database

**Synchronous**: No - errors logged but don't affect deletion

**Can modify user**: No (already deleted)

**Event Payload**:

```typescript
{
  ctx: Context,
  user_id: string,
  tenant: { id: string },
  request: HookRequest
}
```

**API Object**:

```typescript
{
  token: TokenAPI;
}
```

### Screen Hooks

#### `onExecutePreScreen`

Runs before a universal-login screen is shown and when it is submitted.
AuthHero extension; see [Screen Action](#screen-action-pre-screen) for the
screens and behaviour.

**When it runs**: Before every universal-login screen is shown (`render`) and
when it is submitted (`submit`)

**Synchronous**: Yes - can redirect the user or stop the screen

**Event Payload**:

```typescript
{
  ctx: Context,
  screen: { name: string },  // "login-id" | "login-password" | "account-profile" | ...
  prompt: { name: string },  // "login-id" | "reset-password" | "mfa-otp" | "account" | ...
  transaction: {
    phase: "render" | "submit",
    client_id?: string, redirect_uri?: string, requested_scopes: string[],
    state?: string, login_hint?: string, screen_hint?: string, // ...
  },
  operation?: PreScreenOperation, // submit only: "change-email" | "remove-mfa" | ...
  details?: Record<string, string>, // e.g. { factor: "totp" }
  user?: User,               // when known
  connection?: { id?: string, name: string, strategy?: string },
  client?: EnrichedClient,
  organization?: { id: string, name: string, display_name?: string },
  tenant: { id: string },
  request: HookRequest,
}
```

**API Object**:

```typescript
{
  redirect: {
    sendUserTo: (url: string, options?: { query?: Record<string, string> }) => void
  },
  access: {
    deny: (reason?: string) => void  // Shows reason on the error page
  },
  token: TokenAPI
}
```

## API Objects

### Token API

Available in all hooks:

```typescript
api.token.createServiceToken({
  scope: 'read:users write:users',
  expiresInSeconds: 300,
  customClaims: {                        // Optional custom claims
    'https://my-app.com/role': 'admin',
    tenant_type: 'enterprise'
  }
}): Promise<string>
```

By default the token is issued for the built-in `auth-service` client and the
tenant's default audience. Pass `clientId` (and optionally `audience`) to mint
a token for a DB-registered M2M client instead — the requested `scope` and
`audience` must be authorized by an existing `client_grant`, otherwise the
call throws:

```typescript
const token = await api.token.createServiceToken({
  clientId: "auth-email-sender",
  scope: "email:queue",
  audience: "urn:sesamy",
});
```

### User API (Pre-Registration, Pre-Update)

```typescript
api.user.setUserMetadata(key: string, value: any): Promise<void>
```

### Redirect API (Post-Login)

```typescript
// Redirect user
api.redirect.sendUserTo(url: string, options?: {
  query?: Record<string, string>
}): void

// Create signed token for redirect
api.redirect.encodeToken({
  secret: string,
  payload: Record<string, any>,
  expiresInSeconds?: number
}): string

// Validate redirect token
api.redirect.validateToken({
  secret: string,
  tokenParameterName?: string
}): Record<string, any> | null
```

### Cancel API (Update/Deletion)

```typescript
api.cancel(): void  // Throws exception to block operation
```

### Deny API (Validation)

```typescript
api.deny(reason?: string): void  // Denies the operation with optional reason
```

## Hook Execution Order Summary

| Hook                                    | When                       | Sync/Async | Can Modify         |
| --------------------------------------- | -------------------------- | ---------- | ------------------ |
| `onExecuteValidateRegistrationUsername` | Identifier page (no user)  | Sync       | N/A                |
| `preUserRegistrationHook`               | Before user creation       | Sync       | No                 |
| `onExecutePreUserRegistration`          | Before user creation       | Sync       | Yes (metadata)     |
| User Created                            | -                          | -          | -                  |
| `onExecutePostUserRegistration`         | After user creation        | Async      | No                 |
| `postUserRegistrationWebhook`           | After user creation        | Async      | No                 |
| `onExecutePostLogin`                    | After authentication       | Sync       | Yes (flow)         |
| Post-Login Forms/Pages                  | After `onExecutePostLogin` | Sync       | Yes (collect data) |
| Post-Login Webhooks                     | After authentication       | Async      | No                 |
| `onExecutePreUserUpdate`                | Before update              | Sync       | Yes                |
| User Updated                            | -                          | -          | -                  |
| `onExecutePreUserDeletion`              | Before deletion            | Sync       | No                 |
| User Deleted                            | -                          | -          | -                  |
| `onExecutePostUserDeletion`             | After deletion             | Async      | No                 |

## Code Executors

In addition to code-based hooks defined at initialization time, AuthHero supports **user-authored code hooks** — code stored in the database and executed at runtime via the Management API. These are managed through the Actions and Hook Code APIs.

To execute user-authored code safely, AuthHero uses a **Code Executor** — a pluggable runtime that sandboxes untrusted code. The executor uses a **recording proxy pattern**: user code calls API methods (e.g., `api.accessToken.setCustomClaim()`), those calls are recorded, and then replayed against the real API objects on the server side.

### Available Executors

#### `LocalCodeExecutor`

Uses `new Function()` to run code inline. No isolation or sandboxing — suitable for **local development only**.

```typescript
import { init, LocalCodeExecutor } from "authhero";

const { app } = init({
  dataAdapter,
  codeExecutor: new LocalCodeExecutor(),
});
```

#### `WorkerLoaderCodeExecutor`

Uses [Cloudflare Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/) to spin up isolated Workers on demand. Each hook execution runs in its own sandboxed v8 isolate with no access to the parent worker's bindings or env. Outbound `fetch()` is allowed, so user actions can call Slack, email APIs, etc.

Workers are cached by `hookCodeId` + code hash via `env.LOADER.get()`, so the same code stays warm across requests while code updates automatically get a fresh Worker.

**Wrangler configuration:**

```toml
[[worker_loaders]]
binding = "LOADER"
```

**Usage:**

```typescript
import { init } from "authhero";
import { WorkerLoaderCodeExecutor } from "@authhero/cloudflare-adapter";

const { app } = init({
  dataAdapter,
  codeExecutor: new WorkerLoaderCodeExecutor({
    loader: env.LOADER,
  }),
});
```

> Previously exported as `CloudflareCodeExecutor` from the `authhero` package. That export has been removed — import `WorkerLoaderCodeExecutor` from `@authhero/cloudflare-adapter` instead.

### User Code Format

User-authored code hooks use `exports.onExecuteXxx` functions:

```javascript
exports.onExecutePostLogin = async (event, api) => {
  if (event.user.email.endsWith("@vip.com")) {
    api.accessToken.setCustomClaim("vip", true);
  }
};
```

Supported triggers and their export names:

| Trigger                  | Export Function                         | Execution                                           |
| ------------------------ | --------------------------------------- | --------------------------------------------------- |
| `post-user-login`        | `exports.onExecutePostLogin`            | Inline (mutates the token)                          |
| `credentials-exchange`   | `exports.onExecuteCredentialsExchange`  | Inline (mutates the token)                          |
| `pre-user-registration`  | `exports.onExecutePreUserRegistration`  | Inline (blocks / mutates the user before creation)  |
| `post-user-registration` | `exports.onExecutePostUserRegistration` | Outbox-backed (retried)                             |
| `pre-user-update`        | `exports.onExecutePreUserUpdate`        | Inline (can deny the update)                        |
| `post-user-update`       | `exports.onExecutePostUserUpdate`       | Outbox-backed (retried); best effort without outbox |
| `pre-user-deletion`      | `exports.onExecutePreUserDeletion`      | Inline (can deny deletion)                          |
| `post-user-deletion`     | `exports.onExecutePostUserDeletion`     | Outbox-backed (retried); best effort without outbox |

### Denying a login and failing closed

An action can refuse the request it runs for. The execution is stored with status `canceled` and later actions on the trigger don't run.

| Trigger                 | Call                            | Result                                                                                         |
| ----------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `credentials-exchange`  | `api.access.deny(code, reason)` | The token request returns 400 and no tokens are signed. Covers every grant, including refresh. |
| `post-user-login`       | `api.access.deny(reason)`       | The login fails with 403 `access_denied`, the login session is marked failed, and a failed-login log (`f`) is written instead of a successful one. |
| `pre-user-registration` | `api.access.deny(code, reason)` | The signup returns 400 and the user is not created.                                            |

In `post-user-login`, `api.idToken.setCustomClaim` and `api.accessToken.setCustomClaim` add claims to the tokens issued for that login, including the authorization-code exchange. Unlike Auth0, AuthHero doesn't run post-login actions again on a refresh-token exchange, so tokens from a refresh don't carry these claims. Set claims that must survive a refresh in a `credentials-exchange` action, which runs on every grant. `api.redirect.sendUserTo` and `api.prompt.render` aren't supported in post-login actions yet: the call is ignored and the execution records an `unsupported_api` error.

By default an action that doesn't finish lets the request through: a run past the 5-second timeout, an execution that fails, or a thrown error is recorded on the execution and the request continues. For an action whose job is to refuse (a membership check, a fraud check), set `fail_closed` on the hook binding:

```bash
curl -X POST /api/v2/hooks \
  -d '{
    "trigger_id": "credentials-exchange",
    "code_id": "<action id>",
    "enabled": true,
    "metadata": { "fail_closed": true }
  }'
```

With `fail_closed`, `credentials-exchange`, `post-user-login` and `pre-user-registration` deny the request instead, with the reason `action_timeout` or `action_failed`. A binding whose action can't run at all (no code executor configured, or the action was deleted) is denied too. `pre-screen` reads the same key, see [Ordering and failures](#ordering-and-failures).

### Console output is persisted

`console.log` inside a code hook is not just a development aid — the executor captures it and AuthHero writes it to the `action_executions` table, one row per execution, where it stays for the [retention window](/deployment/data-retention).

Two limits apply:

- **256 characters per execution.** A budget for the whole execution's console output, spent across lines in order rather than trimmed per line. Output past the budget is cut and the record gains an explicit `[authhero] console output truncated at 256 characters …` line, so a truncated record is never mistaken for a complete one. Each executor separately caps its own capture at 50 entries × 500 characters before this.

  Auth0 uses the same number but charges it [per Action](https://auth0.com/docs/customize/actions/limitations); AuthHero charges it once for the whole execution, so a trigger with several actions bound to it is **stricter** here than on Auth0. Budget for it accordingly if you are porting Auth0 actions across.

- **10 days of history**, the default `actionExecutionsRetentionDays` for [`runRetention`](/deployment/data-retention) — this one matches Auth0's execution-storage window exactly.

Because this output is durably stored, **never log secrets or PII from a code hook**. A line like `console.log(JSON.stringify(user))` writes an email address, name and `app_metadata` into a diagnostics table, and a line dumping response headers can write a bearer token there. The 256-character cap bounds the volume; it does not make the first 256 characters safe. `credentials-exchange` in particular runs on every token exchange, including refresh grants, so anything logged there is written on the hottest path in the system.

#### Turning persistence down or off

The `actionExecutionLogs` option on `init()` controls which console output is written to `action_executions.logs`, for the whole deployment:

```ts
const { app } = init({
  dataAdapter,
  actionExecutionLogs: "errors", // "full" (default) | "errors" | "off"
});
```

| Mode               | What is persisted to `logs`                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `"full"` (default) | Console output of every action in the execution, subject to the 256-character budget above.                                                                                                                        |
| `"errors"`         | Only the output of actions that failed — an action that threw or returned an error, or one that denied access. Output from successful actions in the same execution is dropped; if none failed, `logs` is omitted. |
| `"off"`            | Nothing. `logs` is always omitted.                                                                                                                                                                                 |

The setting applies only at persistence time. Hooks still capture and see their own console output while they run, and the execution record itself (status and per-action results) is written in every mode. Code hooks delivered through the outbox honor it too: when you drain the outbox from a cron, pass the same value as `actionExecutionLogs` to `runOutboxRelay` / `createDefaultDestinations`.

`"errors"` or `"off"` is recommended for high-volume triggers such as `credentials-exchange`, and anywhere hook output may contain user data you do not want stored.

### Delivery for post-registration, post-update and post-deletion code hooks

`post-user-registration` code hooks require the [outbox pipeline](../architecture/hooks-pipeline.md), where `CodeHookDestination` delivers them through the same durable path as webhooks.

When the outbox is enabled, `post-user-update` and `post-user-deletion` use that pipeline too, with the guarantees below. Without an outbox, these two triggers run as best-effort background work, with no retries or dead-letter support.

- **Retries + dead-letter**: a failing code hook is retried with exponential backoff and dead-lettered after `maxRetries`, then surfaced via the [Failed events](/customization/failed-events) endpoints.
- **At-least-once**: an outbox event can be retried, so a code hook may run more than once. Its event id is passed to your code as `event.idempotency_key` — use it to deduplicate downstream side effects.
- **Ordering**: delivery follows the committed user write. Post-update snapshots describe that write before automatic account linking and post-update template side effects; see [stored user lifecycle Actions](#stored-user-lifecycle-actions).

The token-mutating triggers (`post-user-login`, `credentials-exchange`) still run inline — they must alter the live token in the request and cannot be deferred.

When running the [outbox as a cron drain](/deployment/outbox-cron), pass the same `codeExecutor` to `runOutboxRelay` / `createDefaultDestinations` so code hooks that failed per-request delivery are actually retried rather than skipped.

### Management API

Code hooks are managed through two API endpoints:

**Hook Code** — stores the code itself:

```bash
# Create hook code
POST /api/v2/hook-code
{ "code": "exports.onExecutePostLogin = async (event, api) => { ... }" }

# Update hook code (triggers re-deploy if executor supports it)
PUT /api/v2/hook-code/{id}
{ "code": "exports.onExecutePostLogin = async (event, api) => { ... }" }
```

**Hooks** — binds code to a trigger:

```bash
# Create a code hook bound to a trigger
POST /api/v2/hooks
{
  "name": "VIP Claims",
  "trigger_id": "post-user-login",
  "code_id": "hc_abc123",
  "enabled": true
}
```

## Best Practices

1. **Keep hooks fast**: Hooks run in the critical authentication path
2. **Handle errors gracefully**: Failed async hooks are logged but may not block flows
3. **Use appropriate hook types**:
   - Code hooks for synchronous logic
   - Webhooks for async notifications
   - Form/Page hooks for user interaction
4. **Test thoroughly**: Hooks can significantly impact authentication behavior
5. **Monitor hook execution**: Check logs for hook failures
6. **Use token API for external calls**: Create service tokens for authenticated API requests
7. **Be careful with cancellation**: Only cancel operations when absolutely necessary
8. **Validate early**: Use `onExecuteValidateRegistrationUsername` for early validation before creating users

## Debugging

Hooks log failures to the tenant's log stream with type `FAILED_HOOK`. Check logs for:

- Hook execution errors
- Webhook invocation failures
- Form/page redirect issues

Example log entry:

```json
{
  "type": "failed_hook",
  "description": "Post user registration hook failed",
  "user_id": "auth0|123",
  "date": "2025-11-04T10:30:00.000Z"
}
```

## Common Use Cases

### Block signups from certain domains

```typescript

```

## Common Use Cases

### Block signups from certain domains

```typescript
onExecuteValidateRegistrationUsername: async (event, api) => {
  const blockedDomains = ["tempmail.com", "disposable.com"];
  const domain = event.user.email.split("@")[1];

  if (blockedDomains.includes(domain)) {
    api.deny("Signups from disposable email providers are not allowed");
  }
};
```

````
```

### Enrich user profile on registration

```typescript
onExecutePreUserRegistration: async (event, api) => {
  await api.user.setUserMetadata("signup_date", new Date().toISOString());
  await api.user.setUserMetadata("signup_ip", event.request.ip);
  await api.user.setUserMetadata(
    "signup_country",
    event.request.geoip?.countryCode,
  );
};
```

### Require MFA for admin users

```typescript
onExecutePostLogin: async (event, api) => {
  const isAdmin = event.authorization.roles.includes("admin");
  const hasMFA = event.authentication.methods.some((m) => m.name === "mfa");

  if (isAdmin && !hasMFA) {
    api.prompt.render("mfa-enrollment-form");
  }
};
```

### Prevent email changes for certain users

```typescript
onExecutePreUserUpdate: async (event, api) => {
  if (event.updates.email && event.user.app_metadata?.email_locked) {
    api.cancel();
  }
};
```

### Send notification on user deletion

```typescript
onExecutePostUserDeletion: async (event, api) => {
  const token = await api.token.createServiceToken({
    scope: "send:notifications",
    expiresInSeconds: 60,
  });

  await fetch("https://api.example.com/notifications", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "user_deleted",
      user_id: event.user_id,
    }),
  });
};
```
````
