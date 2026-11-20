import {
  AuthParams,
  Strategy,
  StrategyType,
  isDatabaseConnectionStrategy,
} from "@authhero/adapter-interfaces";
import { JSONHTTPException } from "../errors/json-http-exception";
import { Context } from "hono";
import { Bindings, Variables } from "../types";
import { resolvePrimaryUser } from "../helpers/users";
import { resolveClientDatabaseConnectionName } from "../helpers/database-connection-scope";
import { createFrontChannelAuthResponse } from "./common";
import { getEnrichedClient } from "../helpers/client";
import {
  isUsernamePasswordProvider,
  resolveUsernamePasswordProvider,
} from "../utils/username-password-provider";

async function getProviderFromRealm(
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>,
  tenant_id: string,
  realm: string,
  isDatabaseRealm: boolean,
) {
  if (isDatabaseRealm) {
    return resolveUsernamePasswordProvider(ctx.env, tenant_id);
  }

  if (realm === Strategy.EMAIL) {
    return Strategy.EMAIL;
  }

  throw new JSONHTTPException(403, { message: "Invalid realm" });
}

/**
 * Drop keys whose value is `undefined` so spreading the object never blanks a
 * value the target already has. The /authorize query schema yields a key for
 * every optional parameter, so a plain spread would overwrite the stored
 * authParams with `undefined` for everything the caller left out.
 */
function omitUndefined<T extends object>(value: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      Object.assign(result, { [key]: entry });
    }
  }
  return result;
}

export async function ticketAuth(
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>,
  tenant_id: string,
  ticketId: string,
  authParams: AuthParams,
  realm: string,
) {
  const { env } = ctx;

  ctx.set("connection", realm);

  const code = await env.data.codes.get(tenant_id, ticketId, "ticket");
  if (!code || code.used_at || !code.login_id) {
    throw new JSONHTTPException(403, { message: "Ticket not found" });
  }

  const loginSession = await env.data.loginSessions.get(
    tenant_id,
    code.login_id,
  );
  if (!loginSession || !loginSession.authParams.username) {
    throw new JSONHTTPException(403, { message: "Session not found" });
  }

  // The ticket is bound to the client that verified the credentials. Redeeming
  // it under a different client_id is never legitimate — auth0.js sends the
  // same clientID to both endpoints — so refuse rather than let the mismatch
  // reach the code exchange.
  if (
    authParams.client_id &&
    authParams.client_id !== loginSession.authParams.client_id
  ) {
    throw new JSONHTTPException(403, { message: "Invalid client" });
  }

  const client = await getEnrichedClient(
    env,
    loginSession.authParams.client_id,
    tenant_id,
  );
  ctx.set("client_id", loginSession.authParams.client_id);

  await env.data.codes.used(tenant_id, ticketId);

  // A database realm is the generic `Username-Password-Authentication` or the
  // name of a database connection enabled on the client (#1703).
  const isDatabaseRealm =
    realm === Strategy.USERNAME_PASSWORD ||
    client.connections.some(
      (c) => c.name === realm && isDatabaseConnectionStrategy(c.strategy),
    );

  // A login ticket only covers a password in the connection /co/authenticate
  // verified it in, which it records on the login session. The realm sent
  // here must resolve to that same database connection; any other realm,
  // including `email`, is refused. Other `ticket` codes (for example guardian
  // enrollment tickets) point at login sessions without a recorded connection
  // and never covered a password, so a missing connection is refused too.
  const verifiedConnection = loginSession.authParams.connection;
  const databaseConnection = isDatabaseRealm
    ? resolveClientDatabaseConnectionName(client, realm)
    : undefined;
  if (
    !verifiedConnection ||
    !databaseConnection ||
    databaseConnection !== verifiedConnection
  ) {
    throw new JSONHTTPException(403, { message: "Invalid realm" });
  }

  const provider = await getProviderFromRealm(
    ctx,
    tenant_id,
    realm,
    isDatabaseRealm,
  );
  if (databaseConnection) {
    ctx.set("connection", databaseConnection);
  }

  // Look up the connection to get its strategy
  const connection = client.connections.find(
    (c) => c.name === (databaseConnection ?? realm),
  );
  const strategy =
    connection?.strategy ||
    (isUsernamePasswordProvider(provider)
      ? Strategy.USERNAME_PASSWORD
      : Strategy.EMAIL);
  const strategy_type = isDatabaseConnectionStrategy(strategy)
    ? StrategyType.DATABASE
    : StrategyType.PASSWORDLESS;

  // The ticket records the user /co/authenticate verified the password of.
  // Log in that user, resolved to its cluster root, rather than looking the
  // username up again: another row could match the same username by now. A
  // ticket without a recorded user, or whose user no longer exists, is
  // refused.
  const verifiedUser = code.user_id
    ? await env.data.users.get(tenant_id, code.user_id)
    : null;
  if (!verifiedUser) {
    throw new JSONHTTPException(403, { message: "Invalid ticket" });
  }
  const user = await resolvePrimaryUser(
    env.data.users,
    tenant_id,
    verifiedUser,
  );
  if (user.linked_to) {
    throw new JSONHTTPException(403, { message: "Invalid ticket" });
  }

  ctx.set("username", user.email || user.phone_number);
  ctx.set("user_id", user.user_id);

  // /authorize is the authorization request — it owns scope, audience,
  // response_type, redirect_uri, nonce, state and PKCE. /co/authenticate only
  // verified credentials and minted the ticket, so its login session carries
  // little more than the username. Merge the two with /authorize winning for
  // everything it actually specified, and persist the result: the code
  // exchange reads scope and audience back off the login session (see
  // authorizationCodeGrantUser), so a scope that lives only on this request
  // would be silently dropped — taking `offline_access`, and with it the
  // refresh token, along with it.
  //
  // client_id and username are excluded from that merge: they identify who the
  // ticket was minted for, and both are caller-controlled at /authorize
  // (`username` is populated from `login_hint`). The code exchange re-reads
  // client_id off the login session to enforce RFC 6749 §10.5 — that a code is
  // redeemed by the client it was issued to — so letting /authorize rewrite it
  // would hand that check an attacker-supplied value.
  const mergedAuthParams: AuthParams = {
    ...loginSession.authParams,
    ...omitUndefined(authParams),
    client_id: loginSession.authParams.client_id,
    username: loginSession.authParams.username,
    // Likewise the connection the password was verified in.
    connection: loginSession.authParams.connection,
  };

  await env.data.loginSessions.update(tenant_id, loginSession.id, {
    authParams: mergedAuthParams,
  });

  // Let createFrontChannelAuthResponse handle session creation and state transitions
  // It will authenticate the login session and create/link a session as needed
  return createFrontChannelAuthResponse(ctx, {
    authParams: mergedAuthParams,
    loginSession: { ...loginSession, authParams: mergedAuthParams },
    user,
    client,
    authConnection: databaseConnection ?? realm,
    authStrategy: {
      strategy,
      strategy_type,
    },
  });
}
