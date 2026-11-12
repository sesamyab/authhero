import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Bindings, Variables } from "../../types";
import { initJSXRoute } from "./common";
import ForgotPasswordPage from "../../components/ForgotPasswordPage";
import ForgotPasswordSentPage from "../../components/ForgotPasswordSentPage";
import { requestPasswordReset } from "../../authentication-flows/password";
import { defineRoute } from "../../utils/define-route";
import { enforcePreAccountAction } from "../../hooks/pre-account-action";
import { getPrimaryUserByEmail } from "../../helpers/users";
const getRoot = defineRoute({
  route: createRoute({
    tags: ["login"],
    method: "get",
    path: "/",
    request: {
      query: z.object({
        state: z.string().openapi({
          description: "The state parameter from the authorization request",
        }),
      }),
    },
    responses: {
      200: {
        description: "Response",
      },
    },
  }),
  handler: async (ctx) => {
    const { state } = ctx.req.valid("query");

    const { theme, branding, client, loginSession } = await initJSXRoute(
      ctx,
      state,
    );

    // Password reset starts before sign-in: the user, if any, comes from the
    // identifier entered so far.
    const email = loginSession.authParams.username;
    await enforcePreAccountAction(ctx, {
      tenantId: client.tenant.id,
      operation: "reset-password",
      client,
      user: email
        ? () =>
            getPrimaryUserByEmail({
              userAdapter: ctx.env.data.users,
              tenant_id: client.tenant.id,
              email,
            })
        : undefined,
    });

    return ctx.html(
      <ForgotPasswordPage
        theme={theme}
        branding={branding}
        client={client}
        state={state}
        email={loginSession.authParams.username}
      />,
    );
  },
});

const postRoot = defineRoute({
  route: createRoute({
    tags: ["login"],
    method: "post",
    path: "/",
    request: {
      query: z.object({
        state: z.string().openapi({
          description: "The state parameter from the authorization request",
        }),
      }),
    },
    responses: {
      200: {
        description: "Response",
      },
    },
  }),
  handler: async (ctx) => {
    const { state } = ctx.req.valid("query");

    const { theme, branding, client, loginSession } = await initJSXRoute(
      ctx,
      state,
    );

    await requestPasswordReset(
      ctx,
      client,
      loginSession.authParams.username!,
      loginSession.id,
    );

    return ctx.html(
      <ForgotPasswordSentPage
        theme={theme}
        branding={branding}
        client={client}
        state={state}
      />,
    );
  },
});

export const forgotPasswordRoutes = new OpenAPIHono<{
  Bindings: Bindings;
  Variables: Variables;
}>().openapiRoutes([getRoot, postRoot] as const);
