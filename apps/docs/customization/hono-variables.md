---
title: Hono Variables
description: Context variables in AuthHero using Hono's var system including tenant_id, ip, client_id, user_id, auth0_client, and authentication variables.
---

# Hono Variables in AuthHero

AuthHero uses [Hono's context variables system](https://hono.dev/api/context#var) to store and share data across middleware and route handlers. This document describes the available variables and how to use them.

## Overview

Variables in AuthHero are stored in the Hono context (`ctx.var`) and provide a type-safe way to access request-specific data throughout the request lifecycle. All variables are automatically populated by middleware and are available in route handlers without additional setup.

## Available Variables

### Core Variables

| Variable        | Type      | Description                                                                                                            | Set By                 |
| --------------- | --------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `tenant_id`     | `string`  | The current tenant identifier. Resolution order is documented in [Tenant Resolution Chain](/customization/multi-tenancy/subdomain-routing#tenant-resolution-chain). | `tenantMiddleware`     |
| `ip`            | `string`  | Client IP address (from `x-real-ip` header) | `clientInfoMiddleware` |
| `client_id`     | `string?` | OAuth client identifier                     | Various auth flows     |
| `user_id`       | `string?` | Current user identifier                     | Auth middleware        |
| `username`      | `string?` | Username/email for current request          | Auth flows             |
| `connection`    | `string?` | Authentication connection name              | Auth flows             |
| `custom_domain` | `string?` | Custom domain for the request               | Domain middleware      |

### Authentication Variables

| Variable       | Type                                  | Description             | Set By           |
| -------------- | ------------------------------------- | ----------------------- | ---------------- |
| `user`         | `{ sub: string; tenant_id: string }?` | Authenticated user info | `authMiddleware` |
| `loginSession` | `LoginSession?`                       | Current login session   | Login flows      |

### Client Information Variables

These variables are automatically extracted from HTTP headers and query parameters by the `clientInfoMiddleware`:

| Variable       | Type               | Description                     | Source                             |
| -------------- | ------------------ | ------------------------------- | ---------------------------------- |
| `auth0_client` | `Auth0ClientInfo?` | Parsed Auth0 client information | `auth0Client` query parameter      |
| `useragent`    | `string?`          | User agent string               | `user-agent` header                |
| `countryCode`  | `CountryCode?`     | ISO country code                | `cf-ipcountry` header (CloudFlare) |

#### Auth0 Client Structure

The `auth0_client` variable contains parsed information from the `auth0Client` query parameter. The middleware supports both JSON and string formats:

**JSON Format** (preferred):

```json
{
  "name": "auth0-spa-js",
  "version": "1.13.6",
  "env": {
    "node": "16.14.0"
  }
}
```

**String Format** (legacy support):

```
auth0-spa-js/1.13.6 (env: node/16.14.0)
```

Both formats are parsed into the same TypeScript structure:

```typescript
type Auth0ClientInfo = {
  name: string; // e.g., "auth0-spa-js"
  version: string; // e.g., "1.13.6"
  env?: {
    // Optional environment info
    node?: string; // e.g., "16.14.0"
  };
};
```

The parsing uses Zod schemas for validation, ensuring type safety and catching malformed client information gracefully.

### Debug Variables

| Variable | Type      | Description                  | Set By             |
| -------- | --------- | ---------------------------- | ------------------ |
| `body`   | `any?`    | Request body (for debugging) | Request processing |
| `log`    | `string?` | Log context information      | Logging middleware |

## Usage in Route Handlers

### Basic Access

```typescript
app.get("/example", async (ctx) => {
  // Access variables directly
  const tenantId = ctx.get("tenant_id");
  const clientIp = ctx.get("ip");
  const userAgent = ctx.get("useragent");
  const auth0Client = ctx.get("auth0_client");

  console.log(`Request from ${clientIp} in tenant ${tenantId}`);

  if (auth0Client) {
    console.log(`Client: ${auth0Client.name} v${auth0Client.version}`);
  }

  return ctx.json({ message: "Success" });
});
```

### Type-Safe Access

`user` is set by the authentication middleware, which runs inside the Management API and only for routes whose OpenAPI definition declares `Bearer` security. A route of your own gets it when you mount it there with `managementApiExtensions`. `authhero` does not export its `Variables` type, so declare the variables your handler reads:

```typescript
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { init } from "authhero";

type AuthHeroVariables = {
  user?: { sub: string; tenant_id: string };
  countryCode?: string;
};

const whoami = new OpenAPIHono<{ Variables: AuthHeroVariables }>();

whoami.openapi(
  createRoute({
    method: "get",
    path: "/",
    security: [{ Bearer: [] }], // the middleware validates the token and sets `user`
    responses: { 200: { description: "The authenticated caller" } },
  }),
  async (ctx) => {
    const user = ctx.get("user"); // { sub: string; tenant_id: string } | undefined
    const countryCode = ctx.get("countryCode");

    return ctx.json({ sub: user?.sub, countryCode });
  },
);

// Served at GET /api/v2/whoami
const { app } = init({
  dataAdapter,
  managementApiExtensions: [{ path: "/whoami", router: whoami }],
});
```

On a plain route (`app.get(...)`), or on one without `Bearer` security, `user` is `undefined` even when the request carries a valid token.

### Setting Variables

Variables can be set by middleware or route handlers:

```typescript
app.use(async (ctx, next) => {
  // Set a custom variable
  ctx.set("custom_data", { timestamp: Date.now() });
  await next();
});

app.post("/login", async (ctx) => {
  // Set user context after authentication
  ctx.set("user_id", "user123");
  ctx.set("username", "john@example.com");

  return ctx.json({ success: true });
});
```

## Reading Client Information

The client-information variables are set on every request, so read them from the context directly:

```typescript
app.get("/client-info", async (ctx) => {
  const auth0Client = ctx.get("auth0_client"); // { name, version, env? } | undefined

  return ctx.json({
    auth0Client,
    // e.g. "auth0-spa-js/1.13.6"; AuthHero's logs also append "(env: node/…)" when set
    auth0ClientString: auth0Client
      ? `${auth0Client.name}/${auth0Client.version}`
      : undefined,
    ip: ctx.get("ip"),
    userAgent: ctx.get("useragent"),
    country: ctx.get("countryCode"),
  });
});
```

AuthHero's own helpers for this (`getClientInfoFromContext`, `getClientInfoWithStringAuth0Client` and `stringifyAuth0Client` in `src/utils/client-info.ts`) are internal and not exported from the package.

## Middleware Chain

Variables are populated by middleware in this order:

1. **Data Setup** - Database adapters and caching
2. **Client Info Middleware** - Extracts `ip`, `useragent`, `auth0_client`, `countryCode`
3. **Tenant Middleware** - Sets `tenant_id`, `custom_domain`
4. **Auth Middleware** - Sets `user`, authentication context

This ensures that all variables are available when your route handlers execute.

## Best Practices

### 1. Always Check for Undefined

Variables can be undefined, so always check before using:

```typescript
const user = ctx.get("user");
if (user) {
  // Safe to use user.sub and user.tenant_id
  console.log(`User ${user.sub} in tenant ${user.tenant_id}`);
}
```

### 2. Use Type Guards

For complex variables, use type guards:

```typescript
const auth0Client = ctx.get("auth0_client");
if (auth0Client?.name && auth0Client?.version) {
  console.log(`Client: ${auth0Client.name} v${auth0Client.version}`);
}
```

### 3. Document Custom Variables

If you set custom variables in your middleware, document them clearly:

```typescript
// Custom middleware that sets application-specific variables
app.use(async (ctx, next) => {
  ctx.set("request_id", generateRequestId());
  ctx.set("feature_flags", await getFeatureFlags(ctx.get("tenant_id")));
  await next();
});
```

## Related Documentation

- [Hono Context API](https://hono.dev/api/context)
- AuthHero Middleware
- [AuthHero Configuration](configuration.md)
- [API Reference](/customization/core-api-reference)
