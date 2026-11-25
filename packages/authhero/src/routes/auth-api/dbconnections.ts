import { HTTPException } from "hono/http-exception";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AuthParams, LogTypes, Strategy } from "@authhero/adapter-interfaces";
import { Bindings, Variables } from "../../types";
import { logMessage } from "../../helpers/logging";
import {
  getPrimaryUsernamePasswordUser,
  getUsernamePasswordUser,
  resolveUsernamePasswordProvider,
} from "../../utils/username-password-provider";
import { UNIVERSAL_AUTH_SESSION_EXPIRES_IN_SECONDS } from "../../constants";
import { userIdGenerate } from "../../utils/user-id";
import {
  getPasswordPolicy,
  validatePasswordPolicy,
  hashPassword,
} from "../../helpers/password-policy";
import { sendResetPassword, sendValidateEmailAddress } from "../../emails";
import { nanoid } from "nanoid";
import { stringifyAuth0Client } from "../../utils/client-info";
import { setTenantId } from "../../helpers/set-tenant-id";
import { getEnrichedClient } from "../../helpers/client";
import { cimdTenantHint } from "../../helpers/cimd";
import {
  resolveClientDatabaseConnection,
  resolveClientDatabaseConnectionName,
} from "../../helpers/database-connection-scope";
import { defineRoute } from "../../utils/define-route";
import { normalizeEmail } from "../../utils/email";
const postSignup = defineRoute({
  route: createRoute({
    tags: ["dbconnections"],
    method: "post",
    path: "/signup",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              client_id: z.string(),
              // The database connection to use (#1703); it must be enabled
              // on the client. The generic Username-Password-Authentication
              // means the client's default database connection.
              connection: z.string(),
              email: z.string().transform((u) => normalizeEmail(u)),
              password: z.string(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.object({
              _id: z.string(),
              email: z.string().optional(),
              email_verified: z.boolean(),
              app_metadata: z.object({}),
              user_metadata: z.object({}),
            }),
          },
        },
        description: "Created user",
      },
    },
  }),
  handler: async (ctx) => {
    const { email, password, client_id, connection } = ctx.req.valid("json");

    const client = await getEnrichedClient(
      ctx.env,
      client_id,
      cimdTenantHint(client_id, ctx.var.tenant_id),
    );
    ctx.set("client_id", client.client_id);
    setTenantId(ctx, client.tenant.id);

    // The database connection this signup targets; its password policy
    // applies and the user is written with its name.
    const connectionName = resolveClientDatabaseConnectionName(
      client,
      connection,
    );

    // Validate password against connection policy
    const policy = await getPasswordPolicy(
      ctx.env.data,
      client.tenant.id,
      connectionName,
    );

    try {
      await validatePasswordPolicy(policy, {
        tenantId: client.tenant.id,
        userId: "", // No user yet for signup
        newPassword: password,
        data: ctx.env.data,
      });
    } catch (policyError: any) {
      throw new HTTPException(400, {
        message:
          policyError?.message || "Password does not meet the requirements",
      });
    }

    // Deliberately unscoped: the users table is unique per (email, provider)
    // until #1704, so an address held in another database connection would
    // pass a scoped check and then fail the insert with a 409 that reveals
    // the account. Scope this together with the index.
    const existingUser = await getPrimaryUsernamePasswordUser({
      env: ctx.env,
      tenant_id: client.tenant.id,
      username: email,
    });

    if (existingUser) {
      // Auth0 doesn't inform that the user already exists
      throw new HTTPException(400, { message: "Invalid sign up" });
    }

    // Hash password first
    const { hash, algorithm } = await hashPassword(password);

    const provider = await resolveUsernamePasswordProvider(
      ctx.env,
      client.tenant.id,
    );

    // Create the new user with password atomically in a single transaction
    const newUser = await ctx.env.data.users.create(client.tenant.id, {
      user_id: `${provider}|${userIdGenerate()}`,
      email,
      email_verified: false,
      provider,
      // The connection the login lookups for this client scope to.
      connection: connectionName,
      is_social: false,
      password: { hash, algorithm },
    });

    ctx.set("user_id", newUser.user_id);
    ctx.set("username", newUser.email);
    ctx.set("connection", newUser.connection);

    // Send verification email - wrapped in try/catch to prevent signup failure
    // if email sending fails. User can always re-request verification later.
    try {
      await sendValidateEmailAddress(ctx, newUser, undefined, {
        client_id: client.client_id,
      });
    } catch (emailError) {
      console.error("Failed to send verification email:", emailError);
      // Continue with signup - email verification can be retried later
    }

    logMessage(ctx, client.tenant.id, {
      type: LogTypes.SUCCESS_SIGNUP,
      description: "Successful signup",
    });

    return ctx.json({
      _id: newUser.user_id,
      email: newUser.email,
      email_verified: false,
      app_metadata: {},
      user_metadata: {},
    });
  },
});

const postChangePassword = defineRoute({
  route: createRoute({
    tags: ["dbconnections"],
    method: "post",
    path: "/change_password",
    request: {
      body: {
        content: {
          "application/json": {
            schema: z.object({
              client_id: z.string(),
              // The database connection to use (#1703); it must be enabled
              // on the client. The generic Username-Password-Authentication
              // means the client's default database connection.
              connection: z.string(),
              email: z.string().transform((u) => normalizeEmail(u)),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: "Redirect to the client's redirect uri",
      },
    },
  }),
  handler: async (ctx) => {
    const { email, client_id, connection } = ctx.req.valid("json");

    const client = await getEnrichedClient(
      ctx.env,
      client_id,
      cimdTenantHint(client_id, ctx.var.tenant_id),
    );
    ctx.set("client_id", client.client_id);
    setTenantId(ctx, client.tenant.id);

    const databaseConnection = resolveClientDatabaseConnection(
      client,
      connection,
    );
    const connectionName =
      databaseConnection?.name ?? Strategy.USERNAME_PASSWORD;
    const existingUser = await getUsernamePasswordUser({
      env: ctx.env,
      tenant_id: client.tenant.id,
      username: email,
      connection: connectionName,
    });

    if (!existingUser) {
      // To prevent account enumeration, respond with a generic message
      return ctx.html(
        "If an account with that email exists, we've sent instructions to reset your password.",
      );
    }

    const authParams: AuthParams = {
      client_id: client_id,
      username: email,
      audience: client.tenant.default_audience,
      // The reset continues in the connection the request resolved to.
      connection: databaseConnection?.name,
    };

    const loginSession = await ctx.env.data.loginSessions.create(
      client.tenant.id,
      {
        expires_at: new Date(
          Date.now() + UNIVERSAL_AUTH_SESSION_EXPIRES_IN_SECONDS * 1000,
        ).toISOString(),
        authParams,
        csrf_token: nanoid(),
        ip: ctx.get("ip"),
        useragent: ctx.get("useragent"),
        auth0Client: stringifyAuth0Client(ctx.get("auth0_client")),
      },
    );

    await sendResetPassword(
      ctx,
      email,
      loginSession.id,
      loginSession.authParams.state,
    );

    return ctx.html(
      "If an account with that email exists, we've sent instructions to reset your password.",
    );
  },
});

export const dbConnectionRoutes = new OpenAPIHono<{
  Bindings: Bindings;
  Variables: Variables;
}>().openapiRoutes([postSignup, postChangePassword] as const);
