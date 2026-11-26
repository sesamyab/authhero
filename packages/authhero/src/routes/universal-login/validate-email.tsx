import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { LogTypes } from "@authhero/adapter-interfaces";
import { Bindings, Variables } from "../../types";
import { initJSXRoute } from "./common";
import { HTTPException } from "hono/http-exception";
import { getUsersByEmail } from "../../helpers/users";
import { logMessage } from "../../helpers/logging";
import {
  getUsernamePasswordUser,
  isUsernamePasswordProvider,
} from "../../utils/username-password-provider";
import { resolveClientDatabaseConnectionName } from "../../helpers/database-connection-scope";
import EmailValidatedPage from "../../components/EmailValidatedPage";
import { defineRoute } from "../../utils/define-route";
import {
  isPreSignupCodeFor,
  parseCodeState,
} from "../../helpers/code-recipient";
const getRoot = defineRoute({
  route: createRoute({
    tags: ["login"],
    method: "get",
    path: "/",
    request: {
      // Optional so requests without params (e.g. links from old verification
      // emails that never carried state/code) reach the handler and render
      // the branded error page instead of the default raw ZodError JSON.
      query: z.object({
        state: z.string().optional().openapi({
          description: "The state parameter from the authorization request",
        }),
        code: z.string().optional().openapi({
          description: "The code parameter from the authorization request",
        }),
      }),
    },
    responses: {
      200: {
        description: "Email verified confirmation page",
        content: { "text/html": { schema: z.string() } },
      },
      400: {
        description:
          "Branded error page (missing/invalid state or code, expired code)",
        content: { "text/html": { schema: z.string() } },
      },
      500: {
        description: "Branded error page",
        content: { "text/html": { schema: z.string() } },
      },
    },
  }),
  handler: async (ctx) => {
    const { state, code } = ctx.req.valid("query");

    if (!state || !code) {
      throw new HTTPException(400, {
        message: "This verification link is invalid",
      });
    }

    const { env } = ctx;

    const { client, loginSession, theme, branding } = await initJSXRoute(
      ctx,
      state,
    );

    const { username } = loginSession.authParams;
    if (!username) {
      logMessage(ctx, client.tenant.id, {
        type: LogTypes.FAILED_VERIFICATION_EMAIL,
        description: "Username not found in state",
      });
      throw new HTTPException(400, {
        message: "Username not found in state",
      });
    }

    const user = await getUsernamePasswordUser({
      env,
      tenant_id: client.tenant.id,
      username,
      connection: resolveClientDatabaseConnectionName(
        client,
        loginSession.authParams.connection,
      ),
    });
    if (!user) {
      logMessage(ctx, client.tenant.id, {
        type: LogTypes.FAILED_VERIFICATION_EMAIL,
        description: "No user found",
      });
      throw new HTTPException(500, { message: "No user found" });
    }

    const foundCode = await env.data.codes.get(
      client.tenant.id,
      code,
      "email_verification",
    );

    // Only a code sent to this user's address proves it: one issued to the
    // user (not a change-email request, which goes to the new address), or
    // this session's pre-signup code for the username.
    const codeProvesAddress =
      !!foundCode &&
      ((foundCode.user_id === user.user_id &&
        parseCodeState(foundCode).email === undefined &&
        !foundCode.used_at &&
        foundCode.expires_at >= new Date().toISOString()) ||
        isPreSignupCodeFor(foundCode, loginSession.id, username));

    if (
      !foundCode ||
      !codeProvesAddress ||
      !(await env.data.codes.consume(client.tenant.id, code))
    ) {
      logMessage(ctx, client.tenant.id, {
        type: LogTypes.FAILED_VERIFICATION_EMAIL,
        description: "Code not found or expired",
        userId: user.user_id,
      });
      throw new HTTPException(400, { message: "Code not found or expired" });
    }

    await env.data.users.update(client.tenant.id, user.user_id, {
      email_verified: true,
    });

    logMessage(ctx, client.tenant.id, {
      type: LogTypes.SUCCESS_VERIFICATION_EMAIL,
      userId: user.user_id,
    });

    const usersWithSameEmail = await getUsersByEmail(
      env.data.users,
      client.tenant.id,
      username,
    );

    const usersWithSameEmailButNotUsernamePassword = usersWithSameEmail.filter(
      (user) => !isUsernamePasswordProvider(user.provider),
    );

    if (usersWithSameEmailButNotUsernamePassword.length > 0) {
      const primaryUsers = usersWithSameEmailButNotUsernamePassword.filter(
        (user) => !user.linked_to,
      );

      // these cases are currently not handled! if we think they're edge cases and we release this, we should at least inform datadog!
      if (primaryUsers.length > 1) {
        console.error("More than one primary user found for email", username);
      }

      if (primaryUsers.length === 0) {
        console.error("No primary user found for email", username);
        // so here we should ... hope there is only one usersWithSameEmailButNotUsernamePassword
        // and then follow that linked_to chain?
      }

      // now actually link this username-password user to the primary user
      if (primaryUsers.length === 1) {
        await env.data.users.update(client.tenant.id, user.user_id, {
          linked_to: primaryUsers[0]?.user_id,
        });
      }
    }

    return ctx.html(
      <EmailValidatedPage
        theme={theme}
        branding={branding}
        client={client}
        state={state}
      />,
    );
  },
});

export const validateEmailRoutes = new OpenAPIHono<{
  Bindings: Bindings;
  Variables: Variables;
}>().openapiRoutes([getRoot] as const);
