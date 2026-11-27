---
title: Actions & Hooks Comparison
description: Compare AuthHero Actions and hooks with Auth0 Actions. AuthHero implements the Auth0 Actions API and adds user update and deletion triggers, a pre-screen trigger, form and page hooks, template hooks and entity hooks.
---

# Actions & Hooks: AuthHero vs. Auth0

Auth0 deprecated its legacy Hooks in October 2024 in favour of Actions.
AuthHero implements **Actions** with Auth0's Management API and code format, and
also keeps a **hooks** system for things Actions don't cover: callbacks passed to
`init()`, URL webhooks, form and page hooks, template hooks and entity hooks.

::: tip
For the Actions reference, including the `api` methods per trigger and the full
list of differences, see [Actions](/features/actions). For hooks, see the
[Hooks Guide](/features/hooks).
:::

## Quick Comparison

| Feature                                   | Auth0                       | AuthHero                                                                 |
| ----------------------------------------- | --------------------------- | ------------------------------------------------------------------------ |
| Actions Management API                    | ✅                          | ✅ Actions, versions, deploy, test, trigger bindings, executions          |
| `post-login` Action                       | ✅                          | ✅ Claims, deny, linking and MFA; ⚠️ no `api.redirect` / `api.prompt`, not re-run on refresh |
| `credentials-exchange` Action             | ✅ Client credentials only  | ✅ Every grant, including refresh tokens                                 |
| `pre-user-registration` Action            | ✅                          | ✅                                                                       |
| `post-user-registration` Action           | ✅                          | ✅ Delivered through the outbox, with retries                             |
| `custom-email-provider` / `custom-phone-provider` | ✅                  | ✅ Plus per-message-type selection and `useDefaultProvider()`             |
| `custom-token-exchange` Action            | ✅                          | ✅ Plus a declarative JWT verification mode                               |
| `post-change-password`, `send-phone-message`, `password-reset-post-challenge` | ✅ | ❌                                                       |
| Validate registration username            | ❌                          | ✅ Action, webhook or config hook                                         |
| Pre/post user update                      | ❌                          | ✅ Action or config hook (webhook for post-update)                        |
| Pre/post user deletion                    | ❌                          | ✅ Action, webhook or config hook                                         |
| Pre-screen (before a login screen)        | ❌                          | ✅ Action or config hook                                                  |
| npm dependencies in Actions               | ✅                          | ❌ Stored but not loaded                                                  |
| Forms in the login flow                   | ✅ `api.prompt.render`      | ✅ Form hooks on `post-user-login`                                         |
| URL webhooks on auth triggers             | ❌ (Log Streams only)       | ✅                                                                        |
| Config callbacks with server access       | ❌                          | ✅ `init({ hooks })`                                                      |
| Entity hooks (roles, connections, …)      | ❌                          | ✅                                                                        |

## Supported Trigger IDs

Which kind of hook can bind to which trigger:

| Trigger                          | Action (code) | Webhook | Form | Page | Template | Config callback                          |
| -------------------------------- | :-----------: | :-----: | :--: | :--: | :------: | ---------------------------------------- |
| `validate-registration-username` | ✅            | ✅      |      |      |          | `onExecuteValidateRegistrationUsername`  |
| `pre-user-registration`          | ✅            | ✅      |      |      |          | `onExecutePreUserRegistration`           |
| `post-user-registration`         | ✅            | ✅      |      |      | ✅       | `onExecutePostUserRegistration`          |
| `post-user-login`                | ✅            | ✅      | ✅   | ✅   | ✅       | `onExecutePostLogin`                     |
| `credentials-exchange`           | ✅            |         |      |      | ✅       | `onExecuteCredentialsExchange`           |
| `pre-user-update`                | ✅            |         |      |      |          | `onExecutePreUserUpdate`                 |
| `post-user-update`               | ✅            | ✅      |      |      | ✅       | `onExecutePostUserUpdate`                |
| `pre-user-deletion`              | ✅            | ✅      |      |      |          | `onExecutePreUserDeletion`               |
| `post-user-deletion`             | ✅            | ✅      |      |      |          | `onExecutePostUserDeletion`              |
| `pre-screen`                     | ✅            |         |      |      |          | `onExecutePreScreen`                     |
| `custom-email-provider`          | ✅            |         |      |      |          |                                          |
| `custom-phone-provider`          | ✅            |         |      |      |          |                                          |

`custom-token-exchange` Actions are not bound to a trigger; a
[Custom Token Exchange](/features/custom-token-exchange) profile names the Action
it runs. On the Actions API, `post-login` is accepted as an alias for
`post-user-login`.

For detailed information on each hook including payloads, API methods, and examples, see the [Hooks Guide](/features/hooks).

## Key Architectural Differences

### Hook Types

AuthHero supports these kinds of hooks:

1. **Actions**: JavaScript stored per tenant and run in a sandbox, as in Auth0. See [Actions](/features/actions).
2. **Config hooks**: Functions passed to `init({ hooks })`, with full server access
3. **URL Hooks (Webhooks)**: HTTP endpoints called at trigger points
4. **Form Hooks**: Render custom forms in the authentication flow
5. **Page Hooks**: Redirect to custom pages with permission checks
6. **Template Hooks**: Built-in functions, such as account linking, enabled per tenant
7. **Entity Hooks**: Lifecycle hooks for management entities (roles, connections, etc.)

Auth0 offers Actions only. It has no webhooks on auth triggers and no entity-level hooks.

### User Lifecycle Hooks: Synchronous vs. Asynchronous

| Hook Type                       | Execution | Can Block Flow |
| ------------------------------- | --------- | -------------- |
| Validate Signup Email           | Sync      | ✅ Yes         |
| Pre-User Registration           | Sync      | ✅ Yes         |
| Post-User Registration          | Async     | ❌ No          |
| Post-Login (code/form/page)     | Sync      | ✅ Yes         |
| Post-Login (webhooks)           | Async     | ❌ No          |
| Pre-User Update                 | Sync      | ✅ Yes         |
| Pre-User Deletion               | Sync      | ✅ Yes         |
| Post-User Deletion              | Async     | ❌ No          |
| Post-User Registration Webhooks | Async     | ❌ No          |

See the [Hook Execution Order](/features/hooks#hook-execution-order-summary) section for complete lifecycle details.

### Entity Hooks

AuthHero provides entity hooks for managing configuration entities at the data adapter layer. These hooks are **not available in Auth0**.

**Supported Entities:**
- **Roles**: Create, update, delete lifecycle hooks
- **Connections**: Create, update, delete lifecycle hooks
- **Resource Servers**: Create, update, delete lifecycle hooks
- **Role Permissions**: Assign and remove hooks for permission management

**Key Features:**
- Execute at the data adapter layer (not REST layer)
- `before*` hooks can modify or validate data
- `after*` hooks for side effects (audit logging, syncing to external systems)
- Throwing errors in `before*` hooks blocks the operation

**Use Cases:**
- Sync role permissions to external resource servers
- Audit logging for entity changes
- Validate entity configurations before save
- Initialize default settings for new entities

See the [Entity Hooks Guide](/features/hooks#entity-hooks) for detailed documentation and examples.

## Configuration Methods

### Via Code (Initialization)

```typescript
const { app } = init({
  dataAdapter,
  hooks: {
    onExecuteValidateRegistrationUsername: async (event, api) => {
      // Validate signup
    },
    onExecutePostLogin: async (event, api) => {
      // Handle post-login
    },
    // ... other user lifecycle hooks
  },
  entityHooks: {
    roles: [
      {
        beforeCreate: async (context, insert) => {
          // Validate or modify before creation
          return insert;
        },
        afterCreate: async (context, entity) => {
          // Post-creation tasks
        },
      },
    ],
    rolePermissions: [
      {
        afterAssign: async (context, roleId, permissions) => {
          // Sync to external systems
        },
      },
    ],
  },
});
```

### Via Management API

```bash
# Bind Actions to a trigger (Auth0-compatible)
PATCH /api/v2/actions/triggers/post-login/bindings
{
  "bindings": [{ "ref": { "type": "action_name", "value": "My Action" } }]
}

# Create webhook
POST /api/v2/hooks
{
  "name": "Post-Login Webhook",
  "trigger_id": "post-user-login",
  "url": "https://api.example.com/hooks",
  "enabled": true
}

# Create form hook
POST /api/v2/hooks
{
  "trigger_id": "post-user-login",
  "form_id": "form_123",
  "enabled": true
}
```

For complete configuration examples, see the [Hooks Guide Configuration Section](/features/hooks#configuration).

## Migration from Auth0

Auth0 Actions can be moved across as they are:

1. Export your Actions and their trigger bindings, for example with the Auth0
   Deploy CLI or the Auth0 Terraform provider, and apply them to AuthHero's
   Management API.
2. Configure a code executor on the AuthHero server so the Actions run.
3. Check each Action against [Differences from Auth0](/features/actions#differences-from-auth0).
   Replace `require`d npm packages with `fetch` calls. Move claims that must
   survive a refresh from `post-login` to a `credentials-exchange` Action, and
   replace `api.redirect` / `api.prompt.render` with a form or page hook.

Logic that needs server access, or a trigger Auth0 doesn't have, can be written
as a config hook (`onExecutePostLogin`, `onExecutePreUserRegistration`, …) with
the same `(event, api)` signature.

## Hook Templates

AuthHero ships with **pre-defined hook templates** — ready-to-use hooks that implement common authentication patterns. Instead of writing hooks from scratch, you can import a template and plug it straight into your configuration.

::: tip
Auth0 offers Action templates that you copy into your own code. AuthHero's
templates are functions that ship with AuthHero, so a tenant enables them
without owning any code.
:::

### Available Templates

#### `ensureUsername`

Ensures every user has a username, regardless of how they signed up (email, social, SMS, etc.).

**What it does:**

1. After login, checks whether the user already has a username (directly or via a linked identity).
2. If not, extracts candidate usernames from the user's profile fields (in order: `nickname`, `name`, local part of `email`, `phone_number`).
3. Slugifies each candidate (lowercased, diacritics stripped, non-alphanumeric characters replaced with hyphens).
4. Checks uniqueness against existing users and appends numeric suffixes if needed (e.g. `john`, `john2`, `john3`).
5. For username-type accounts (username-password provider), updates the username field directly.
6. For other providers, creates a new linked username account attached to the current user.

**Basic usage:**

```typescript
import { init, preDefinedHooks } from "authhero";

const { app } = init({
  dataAdapter,
  hooks: {
    onExecutePostLogin: preDefinedHooks.ensureUsername(),
  },
});
```

**With custom options:**

```typescript
import { preDefinedHooks } from "authhero";

preDefinedHooks.ensureUsername({
  connection: "my-username-connection", // default: "Username-Password-Authentication"
  provider: "my-custom-provider",       // default: USERNAME_PASSWORD_PROVIDER
  maxRetries: 20,                       // default: 10
});
```

| Option       | Type     | Default                              | Description                                      |
| ------------ | -------- | ------------------------------------ | ------------------------------------------------ |
| `connection` | `string` | `"Username-Password-Authentication"` | Connection name for username accounts             |
| `provider`   | `string` | `USERNAME_PASSWORD_PROVIDER` (`"auth0"`) | Provider used for username accounts               |
| `maxRetries` | `number` | `10`                                 | Max attempts to find a unique username via suffix |

### Using Templates with Your Own Hooks

Since templates return standard hook functions, you can compose them with your own logic:

```typescript
import { init, preDefinedHooks } from "authhero";

const ensureUsernameFn = preDefinedHooks.ensureUsername();

const { app } = init({
  dataAdapter,
  hooks: {
    onExecutePostLogin: async (event, api) => {
      // Your custom logic first
      console.log(`User ${event.user?.user_id} logged in`);

      // Then run the template
      await ensureUsernameFn(event, api);
    },
  },
});
```

## Additional Resources

- [Actions](/features/actions) - Actions reference
- [Hooks Guide](/features/hooks) - Complete hooks documentation
- [Hook Lifecycle](/features/hooks#hook-lifecycle) - Detailed execution flow
- [Hook Types](/features/hooks#hook-types) - Code, webhooks, forms, and pages
- [API Objects](/features/hooks#api-objects) - Available APIs in each hook
- [Best Practices](/features/hooks#best-practices) - Implementation guidelines
- [Common Use Cases](/features/hooks#common-use-cases) - Real-world examples

## Programmatic Hooks in AuthHero

In addition to URL and Form hooks configured through the Management API, AuthHero supports **programmatic hooks** that are defined directly in your application code. These hooks provide powerful server-side customization capabilities and are executed synchronously during various authentication and user lifecycle events.

### Available Programmatic Hooks

AuthHero supports the following programmatic hooks that can be configured when initializing your application:

### Hook Availability Comparison

See [Supported Trigger IDs](#supported-trigger-ids) for which kind of hook can
bind to each trigger.

#### 1. `onExecuteCredentialsExchange`

Triggered during the credentials exchange process (e.g., when exchanging an authorization code for tokens).

**Event Data:**

- `ctx`: Hono context object
- `client`: The client application
- `user`: The authenticated user
- `request`: Request details (IP, user agent, method, URL)
- `scope`: Requested scopes
- `grant_type`: The grant type being used
- `audience`: Optional audience parameter

**API Methods:**

- `accessToken.setCustomClaim(claim, value)`: Add custom claims to the access token
- `idToken.setCustomClaim(claim, value)`: Add custom claims to the ID token
- `access.deny(code, reason?)`: Deny the credentials exchange

#### 2. `onExecutePreUserRegistration`

Triggered before a new user is created in the system.

**Event Data:**

- `ctx`: Hono context object
- `user`: The user object being created
- `request`: Request details (IP, user agent, method, URL)

**API Methods:**

- `user.setUserMetadata(key, value)`: Add or modify user metadata

#### 3. `onExecutePostUserRegistration`

Triggered after a user has been successfully created.

**Event Data:**

- `ctx`: Hono context object
- `user`: The created user object
- `request`: Request details (IP, user agent, method, URL)

**API Methods:**

- `user`: Empty object for future extensibility

#### 4. `onExecutePreUserUpdate`

Triggered before any user update operation.

**Event Data:**

- `ctx`: Hono context object
- `user_id`: The ID of the user being updated
- `updates`: The partial user object with fields being updated
- `request`: Request details (IP, user agent, method, URL)

**API Methods:**

- `user.setUserMetadata(key, value)`: Modify the update data
- `cancel()`: Cancel the update operation

#### 5. `onExecutePostLogin`

Triggered after successful user authentication. This hook is fully compatible with Auth0's Actions API and supports redirect functionality.

**Event Data:**

- `ctx`: Hono context object
- `client`: The client application
- `user`: The authenticated user
- `request`: Request details (IP, user agent, method, URL)
- `scope`: Requested scopes
- `grant_type`: The grant type used

**API Methods:**

- `prompt.render(formId)`: Render a specific form to the user
- `redirect.sendUserTo(url, options?)`: Redirect user to a specific URL (Auth0-compatible)
- `redirect.encodeToken(options)`: Create a secure token for state management
- `redirect.validateToken(options)`: Validate a token from the request

#### 6. `onExecutePreUserDeletion`

Triggered before a user deletion is executed. This allows you to validate the deletion request, perform pre-deletion checks, or cancel the deletion if needed.

**Event Data:**

- `ctx`: Hono context object
- `user`: The user object being deleted
- `user_id`: The ID of the user being deleted
- `tenant`: Object containing the tenant ID
- `request`: Request details (IP, user agent, method, URL)

**API Methods:**

- `cancel()`: Cancel the deletion operation

**Note:** If the hook throws an error or calls `cancel()`, the deletion will be prevented. This is useful for implementing deletion policies, checking for dependencies, or requiring additional confirmation.

#### 7. `onExecutePostUserDeletion`

Triggered after a user has been successfully deleted. This allows you to perform cleanup operations, send notifications, or log the deletion for audit purposes.

**Event Data:**

- `ctx`: Hono context object
- `user`: The user object that was deleted
- `user_id`: The ID of the user that was deleted
- `tenant`: Object containing the tenant ID
- `request`: Request details (IP, user agent, method, URL)

**API Methods:**

- (No API methods - this is an informational hook only)

**Note:** Unlike Auth0 which doesn't have built-in user deletion action triggers, AuthHero provides both pre and post deletion hooks to help with compliance requirements (GDPR, etc.) and cleanup operations. The post-deletion hook runs after successful deletion, so errors in this hook are logged but don't affect the deletion result.

### Configuring Programmatic Hooks

AuthHero supports two ways to configure hooks:

#### Method 1: Config-Based Hooks (Recommended)

Configure hooks directly when initializing your AuthHero application:

```typescript
import { init } from "@authhero/authhero";

const authHero = init({
  dataAdapter: myAdapter,
  hooks: {
    onExecutePreUserRegistration: async (event, api) => {
      // Add custom user metadata during registration
      api.user.setUserMetadata("signup_source", "web");
      api.user.setUserMetadata("onboarding_completed", false);
    },

    onExecutePostLogin: async (event, api) => {
      // Auth0-compatible redirect functionality
      if (event.user?.user_metadata?.requires_setup) {
        api.redirect.sendUserTo("/setup", {
          query: {
            user_id: event.user.user_id,
            step: "profile",
          },
        });
      }
    },
  },
});
```

#### Method 2: Environment-Based Hooks (Legacy)

You can also provide hooks through the environment bindings:

```typescript
import { init } from "@authhero/authhero";
import { createAdapters } from "@authhero/your-adapter";

const env = {
  data: createAdapters(/* your database config */),
  hooks: {
    onExecutePreUserRegistration: async (event, api) => {
      // Add custom user metadata during registration
      api.user.setUserMetadata("signup_source", "web");
      api.user.setUserMetadata("onboarding_completed", false);

      // You can access request details
      console.log(`New user registering from IP: ${event.request.ip}`);
    },

    onExecutePreUserUpdate: async (event, api) => {
      // Validate user updates
      if (event.updates.email && !isValidEmail(event.updates.email)) {
        api.cancel(); // Cancel the update
        return;
      }

      // Add audit metadata
      api.user.setUserMetadata("last_updated_by", "system");
      api.user.setUserMetadata("last_updated_at", new Date().toISOString());
    },

    onExecuteCredentialsExchange: async (event, api) => {
      // Add custom claims to tokens
      api.accessToken.setCustomClaim("tenant_id", event.user?.tenant_id);
      api.idToken.setCustomClaim("role", event.user?.app_metadata?.role);

      // Conditional access control
      if (event.user?.blocked) {
        api.access.deny("access_denied", "User account is blocked");
      }
    },

    onExecutePostUserRegistration: async (event, api) => {
      // Trigger external systems after user creation
      await sendWelcomeEmail(event.user.email);
      await createUserInCRM(event.user);
    },

    onExecutePostLogin: async (event, api) => {
      // Auth0-compatible redirect functionality
      if (event.user?.requires_mfa_setup) {
        api.redirect.sendUserTo("/mfa/setup", {
          query: {
            user_id: event.user.user_id,
            return_to: "/dashboard",
          },
        });
      }

      // Or render a form within the authentication flow
      if (event.user?.requires_terms_acceptance) {
        api.prompt.render("terms-acceptance-form");
      }
    },

    onExecutePreUserDeletion: async (event, api) => {
      // Validate deletion - prevent deletion of admin users
      if (event.user.app_metadata?.role === "admin") {
        api.cancel(); // This will prevent the deletion
        return;
      }

      // Check for dependencies
      const hasActiveSubscription = await checkUserSubscription(event.user_id);
      if (hasActiveSubscription) {
        api.cancel();
        return;
      }
    },

    onExecutePostUserDeletion: async (event, api) => {
      // Perform cleanup operations after user is deleted
      await deleteUserDataFromExternalSystems(event.user_id);
      await sendAccountDeletionEmail(event.user.email);

      // Log for audit purposes
      console.log(
        `User ${event.user_id} deleted from tenant ${event.tenant.id}`,
      );
    },
  },
  // Other environment configuration...
  ISSUER: "https://your-domain.com",
  // ...
};

const { authenticationApp, managementApp } = init({
  dataAdapter: env.data,
});

// Use the apps with your framework (Hono, etc.)
```

### Service Token API (Available in All Hooks)

**All programmatic hooks** in AuthHero provide a `token` API that allows you to generate service tokens for authenticating with external APIs. This is particularly useful when you need to interact with external systems like CRMs, analytics platforms, or third-party services during any authentication or user lifecycle event.

#### API Interface

The token API is available in all hooks via `api.token.createServiceToken()`:

```typescript
api.token.createServiceToken({
  scope: string;                            // The scope(s) for the token (space-separated)
  clientId?: string;                        // Optional: mint a grant-bounded token for a DB-registered M2M client
  audience?: string;                        // Used only with `clientId` — must match an existing `client_grant`
  expiresInSeconds?: number;                // Optional expiration time (default: 3600 = 1 hour)
  customClaims?: Record<string, unknown>;   // Optional custom claims to include in the token
}): Promise<string>
```

The service token is a JWT signed with your AuthHero instance's private key and includes:

- **client_id** (`sub`/`azp`): `"auth-service"` by default, or the value of `clientId` when provided
- **aud**: tenant's default audience by default, or the resolved audience when `clientId`/`audience` is provided
- **scope**: The requested scope(s) (must be a subset of the client's `client_grant` when `clientId` is set)
- **tenant_id**: Your tenant ID
- **gty**: `"client_credentials"` (when `clientId` is provided)
- **exp**: Expiration timestamp
- Any additional **custom claims** you pass via `customClaims`

> **Note:** Reserved JWT claims (`sub`, `iss`, `aud`, `exp`, `nbf`, `iat`, `jti`) cannot be overwritten via `customClaims` — an error will be thrown if attempted.

#### Custom Claims Example

```typescript
onExecutePostLogin: async (event, api) => {
  const token = await api.token.createServiceToken({
    scope: "sync:users",
    expiresInSeconds: 300,
    customClaims: {
      "https://my-app.com/user_id": event.user.user_id,
      "https://my-app.com/connection": event.connection?.name,
      action: "post-login-sync",
    },
  });

  await fetch("https://api.example.com/sync", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ user: event.user }),
  });
},
```

#### Security Considerations

By default the `client_id` (and `azp`/`sub`) is `"auth-service"` so hook-minted tokens are clearly identifiable and easy to validate. When you pass an explicit `clientId`, those claims will instead equal the value you provided — the token is then bounded to a DB-registered M2M client and its existing `client_grant`.

When validating these tokens at external services:

- **`aud`**: equals the tenant's default audience by default, or the resolved audience when `clientId` (and optionally `audience`) is supplied.
- **`scope`**: must be a subset of the client's `client_grant` when `clientId` is provided.
- **`gty`**: is `"client_credentials"` when `clientId` is used.

`tenant_id` always identifies the originating tenant.

#### Available in All Hooks

The token API is available in:

- `onExecuteCredentialsExchange` - Generate tokens during authentication flows
- `onExecutePreUserRegistration` - Generate tokens before user registration
- `onExecutePostUserRegistration` - Generate tokens after user registration
- `onExecutePreUserUpdate` - Generate tokens before user updates
- `onExecutePostLogin` - Generate tokens during post-login flows
- `onExecutePreUserDeletion` - Generate tokens before user deletion
- `onExecutePostUserDeletion` - Generate tokens after user deletion

#### User Registration Example

```typescript
onExecutePostUserRegistration: async (event, api) => {
  // Create user in external CRM after registration
  const serviceToken = await api.token.createServiceToken({
    scope: "write:users",
    expiresInSeconds: 300, // 5 minutes
  });

  await fetch("https://crm.example.com/api/users", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: event.user.email,
      name: event.user.name,
      user_id: event.user.user_id,
    }),
  });
},
```

#### User Deletion Example

Both `onExecutePreUserDeletion` and `onExecutePostUserDeletion` hooks have access to the token API for managing external service cleanup:

##### Pre-Deletion Hook Example

```typescript
onExecutePreUserDeletion: async (event, api) => {
  // Check if user can be deleted from external CRM
  const serviceToken = await api.token.createServiceToken({
    scope: "read:users delete:users",
    expiresInSeconds: 600, // 10 minutes
  });

  const canDelete = await fetch(
    `https://crm.example.com/api/users/${event.user_id}/can-delete`,
    {
      headers: {
        Authorization: `Bearer ${serviceToken}`,
      },
    }
  );

  if (!canDelete.ok) {
    api.cancel(); // Prevent deletion
    return;
  }
},
```

##### Post-Deletion Hook Example

```typescript
onExecutePostUserDeletion: async (event, api) => {
  // Generate token to authenticate with external services
  const serviceToken = await api.token.createServiceToken({
    scope: "delete:user_data",
    expiresInSeconds: 300, // 5 minutes
  });

  // Delete user data from CRM
  await fetch(`https://crm.example.com/api/users/${event.user_id}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${serviceToken}`,
    },
  });

  // Delete user from analytics platform
  await fetch(`https://analytics.example.com/api/users/${event.user_id}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${serviceToken}`,
    },
  });

  // Delete user from notification service
  await fetch(
    `https://notifications.example.com/api/users/${event.user_id}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${serviceToken}`,
      },
    }
  );
},
```

#### Validating Service Tokens in External Services

Your external services should validate the service token by:

1. Verifying the JWT signature using your AuthHero instance's public key (available at `https://your-domain.com/.well-known/jwks.json`)
2. Checking that `client_id` equals `"auth-service"`
3. Verifying the token hasn't expired
4. Validating that the `scope` includes the required permissions

Example validation in an external service:

```typescript
import { jwtVerify, createRemoteJWKSet } from "jose";

const JWKS = createRemoteJWKSet(
  new URL("https://your-authhero-domain.com/.well-known/jwks.json"),
);

async function validateServiceToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: "https://your-authhero-domain.com",
    });

    // Verify it's a service token
    if (payload.client_id !== "auth-service") {
      throw new Error("Invalid client_id");
    }

    // Check required scope
    const scopes = (payload.scope as string)?.split(" ") || [];
    if (!scopes.includes("delete:user_data")) {
      throw new Error("Insufficient scope");
    }

    return payload;
  } catch (error) {
    console.error("Token validation failed:", error);
    throw error;
  }
}
```

## Auth0-Compatible Redirect API

AuthHero's `onExecutePostLogin` hook provides an Auth0-compatible redirect API that allows you to redirect users during the authentication flow:

### Basic Redirect

```typescript
onExecutePostLogin: async (event, api) => {
  // Simple redirect
  api.redirect.sendUserTo("/custom-page");

  // Redirect with query parameters
  api.redirect.sendUserTo("/setup", {
    query: {
      user_id: event.user.user_id,
      source: "login",
      step: "profile",
    },
  });
};
```

### Secure Token Management

```typescript
onExecutePostLogin: async (event, api) => {
  // Create a secure token for state management
  const setupToken = api.redirect.encodeToken({
    secret: "your-secret-key",
    payload: {
      user_id: event.user.user_id,
      action: "profile_setup",
      timestamp: Date.now(),
    },
    expiresInSeconds: 600, // 10 minutes
  });

  // Include token in redirect
  api.redirect.sendUserTo("/setup", {
    query: {
      token: setupToken,
    },
  });
};

// Later, validate the token in your application
onExecutePostLogin: async (event, api) => {
  const tokenData = api.redirect.validateToken({
    secret: "your-secret-key",
    tokenParameterName: "token", // Query param name to look for
  });

  if (tokenData && tokenData.payload.action === "profile_setup") {
    // Token is valid, continue with setup
    api.redirect.sendUserTo("/setup/step-2");
  }
};
```

### Real-World Use Cases

#### Progressive Profiling

```typescript
onExecutePostLogin: async (event, api) => {
  const { user } = event;

  // Check if user needs to complete profile
  if (!user.user_metadata?.profile_completed) {
    api.redirect.sendUserTo("/onboarding/profile", {
      query: {
        step: user.user_metadata?.onboarding_step || "1",
        user_id: user.user_id,
      },
    });
  }
};
```

#### Terms of Service Updates

```typescript
onExecutePostLogin: async (event, api) => {
  const currentToSVersion = "2.1";
  const userToSVersion = event.user.user_metadata?.tos_accepted_version;

  if (userToSVersion !== currentToSVersion) {
    const tosToken = api.redirect.encodeToken({
      secret: process.env.TOS_SECRET,
      payload: {
        user_id: event.user.user_id,
        required_version: currentToSVersion,
        current_version: userToSVersion,
      },
      expiresInSeconds: 1800, // 30 minutes
    });

    api.redirect.sendUserTo("/legal/terms-update", {
      query: {
        token: tosToken,
        version: currentToSVersion,
      },
    });
  }
};
```

#### Admin Impersonation

```typescript
onExecutePostLogin: async (event, api) => {
  // Check if user has impersonation permissions
  const userPermissions = await event.ctx.env.data.userPermissions.list(
    event.client.tenant.id,
    event.user.user_id,
  );

  const canImpersonate = userPermissions.some(
    (perm) => perm.permission_name === "users:impersonate",
  );

  if (canImpersonate && event.client.client_id === "admin-dashboard") {
    api.redirect.sendUserTo("/u/impersonate", {
      query: {
        source: "post-login-hook",
        user_id: event.user.user_id,
      },
    });
  }
};
```

### Hook Error Handling

Programmatic hooks have built-in error handling that varies by hook type:

- **`onExecutePreUserRegistration`**: If the hook throws an error, it is logged but the registration continues. The error does not block user creation.
- **`onExecutePostUserRegistration`**: If the hook throws an error, it is logged but does not affect the completed registration.
- **`onExecutePreUserUpdate`**: If the hook throws an error or calls `api.cancel()`, the update operation is blocked and an HTTP 400 error is returned to the client.
- **`onExecutePreUserDeletion`**: If the hook throws an error or calls `api.cancel()`, the deletion operation is blocked and prevented.
- **`onExecutePostUserDeletion`**: Errors are logged but don't affect the deletion (the user has already been deleted).
- **`onExecuteCredentialsExchange`**: Errors can deny access using the `api.access.deny()` method. Other errors are logged and may affect token generation.
- **`onExecutePostLogin`**: Errors are logged but typically don't prevent the login from completing. However, redirects and form prompts can modify the authentication flow.

### Hook Execution Order

Understanding when hooks execute is important for proper implementation:

**User Registration Flow:**

1. `onExecutePreUserRegistration` - Before user is created (can modify user data)
2. User is created in database
3. `onExecutePostUserRegistration` - After user is created (informational)

**User Update Flow:**

1. `onExecutePreUserUpdate` - Before user is updated (can modify or cancel update)
2. User is updated in database
3. Account linking checks (if email changed)

**User Deletion Flow:**

1. `onExecutePreUserDeletion` - Before user is deleted (can cancel deletion)
2. User is deleted from database
3. Deletion is logged
4. `onExecutePostUserDeletion` - After user is deleted (cleanup operations)

**Login Flow:**

1. User authentication occurs
2. `onExecutePostLogin` - After authentication (can redirect or add form)
3. Tokens are issued (or redirect happens)

**Token Exchange Flow:**

1. `onExecuteCredentialsExchange` - Before tokens are issued (can modify claims or deny)
2. Tokens are generated and returned

### Combining Programmatic and Management API Hooks

AuthHero allows you to use both programmatic hooks and Management API hooks (URL/Form hooks) simultaneously:

1. **Programmatic hooks** execute first and are ideal for:
   - Complex business logic requiring access to your application's dependencies
   - Synchronous operations that need to modify the authentication flow
   - Data validation and transformation

2. **Management API hooks** execute after programmatic hooks and are ideal for:
   - Integration with external services via webhooks
   - User-facing forms and progressive profiling
   - Configuration that can be managed by non-developers

This dual approach provides maximum flexibility, allowing you to handle core business logic in code while providing configurable extension points for specific use cases.

## User Deletion Best Practices

With the addition of `onExecutePreUserDeletion` and `onExecutePostUserDeletion` hooks, you have full control over the user deletion lifecycle. Here are recommended practices:

### Pre-Deletion Validation

Use `onExecutePreUserDeletion` to enforce business rules before deletion:

```typescript
onExecutePreUserDeletion: async (event, api) => {
  const user = await event.ctx.env.data.users.get(
    event.tenant.id,
    event.user_id,
  );

  // Prevent deletion of protected users
  if (user?.app_metadata?.protected) {
    console.log(`Blocked deletion of protected user: ${event.user_id}`);
    api.cancel();
    return;
  }

  // Prevent deletion if user has active subscriptions
  const hasActiveSubscription = await checkActiveSubscription(user);
  if (hasActiveSubscription) {
    console.log(`User ${event.user_id} has active subscription`);
    api.cancel();
    return;
  }

  // Log the deletion request
  console.log(`User deletion approved for: ${event.user_id}`);
};
```

### Post-Deletion Cleanup

Use `onExecutePostUserDeletion` for cleanup operations:

```typescript
onExecutePostUserDeletion: async (event, api) => {
  const userId = event.user_id;
  const tenantId = event.tenant.id;

  // Revoke all tokens
  await revokeAllUserTokens(tenantId, userId);

  // Clean up external systems
  await removeFromCRM(userId);
  await deleteFromAnalytics(userId);
  await notifyExternalSystems("user_deleted", { user_id: userId });

  // Send confirmation (if email available in event context)
  if (event.user?.email) {
    await sendDeletionConfirmation(event.user.email);
  }

  // Audit logging
  console.log(`User ${userId} deleted and cleaned up successfully`);
};
```

### Compliance and Data Retention

When implementing deletion hooks, consider:

1. **GDPR/CCPA Compliance**: Export user data before deletion if required
2. **Audit Trail**: Log who deleted the user and when
3. **Cascade Deletion**: Clean up related data (sessions, tokens, preferences)
4. **Rate Limiting**: Implement rate limits to prevent accidental bulk deletions
5. **Soft Delete Option**: Consider flagging users as deleted rather than removing them
6. **Backup**: Archive critical user data before permanent deletion
7. **Notification**: Notify relevant parties (user, admin, compliance team)

### Complete Example

```typescript
const config: AuthHeroConfig = {
  dataAdapter: adapter,
  hooks: {
    onExecutePreUserDeletion: async (event, api) => {
      const user = await event.ctx.env.data.users.get(
        event.tenant.id,
        event.user_id,
      );

      // Business rule validation
      if (
        user?.app_metadata?.role === "admin" &&
        (await isLastAdmin(event.tenant.id))
      ) {
        console.error("Cannot delete last admin user");
        api.cancel();
        return;
      }

      // Export data for compliance
      if (user) {
        await exportUserDataForCompliance(user);
      }

      console.log(`Pre-deletion checks passed for user: ${event.user_id}`);
    },

    onExecutePostUserDeletion: async (event, api) => {
      // Clean up all user-related data
      await Promise.all([
        revokeAllUserTokens(event.tenant.id, event.user_id),
        deleteUserSessions(event.tenant.id, event.user_id),
        removeFromExternalServices(event.user_id),
        updateAnalytics("user_deleted", { user_id: event.user_id }),
      ]);

      console.log(`User ${event.user_id} fully deleted and cleaned up`);
    },
  },
};
```
