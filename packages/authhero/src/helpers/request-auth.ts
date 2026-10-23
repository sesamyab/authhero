import { Actor } from "@authhero/adapter-interfaces";

export type RequestAuth = {
  user?: { user_id: string; name?: string; email?: string };
  strategy: "jwt";
  credentials: { jti?: string; scopes?: string[] };
};

/**
 * Auth0-style `details.request.auth`: who made a management API call.
 * The top-level `user_id` of the log is the *target*; the caller lives here.
 * M2M callers have no `user` (they are the top-level `client_id`).
 * Returns undefined when the request wasn't authenticated with a token.
 */
export function buildRequestAuth(actor: Actor): RequestAuth | undefined {
  if (!actor.jti && !actor.scopes?.length) return undefined;

  const isUser = actor.type === "admin" && !!actor.id;
  return {
    ...(isUser && {
      user: {
        user_id: actor.id!,
        ...(actor.name ? { name: actor.name } : {}),
        ...(actor.email ? { email: actor.email } : {}),
      },
    }),
    strategy: "jwt",
    credentials: {
      ...(actor.jti ? { jti: actor.jti } : {}),
      ...(actor.scopes ? { scopes: actor.scopes } : {}),
    },
  };
}
