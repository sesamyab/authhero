import { Context } from "hono";
import { Connection, User } from "@authhero/adapter-interfaces";
import { Bindings, Variables } from "../types";
import { EnrichedClient } from "../helpers/client";
import {
  Auth0UpstreamError,
  fetchUserInfo,
  passwordRealmGrant,
} from "../utils/auth0-upstream";
import { hashPassword } from "../helpers/password-policy";
import { userIdGenerate } from "../utils/user-id";
import { resolveUsernamePasswordProvider } from "../utils/username-password-provider";

interface Auth0SourceCredentials {
  tokenEndpoint: string;
  userinfoEndpoint: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Read the upstream credentials from a `strategy: "auth0"` connection. Returns
 * null if any required field is missing — callers should treat this as
 * "migration is not configured" and fall through to the normal failure path.
 */
export function readAuth0SourceCredentials(
  source: Connection,
): Auth0SourceCredentials | null {
  const options = source.options ?? {};
  const tokenEndpoint =
    typeof options.token_endpoint === "string"
      ? options.token_endpoint
      : undefined;
  const userinfoEndpoint =
    typeof options.userinfo_endpoint === "string"
      ? options.userinfo_endpoint
      : undefined;
  const clientId =
    typeof options.client_id === "string" ? options.client_id : undefined;
  const clientSecret =
    typeof options.client_secret === "string"
      ? options.client_secret
      : undefined;

  if (!tokenEndpoint || !userinfoEndpoint || !clientId || !clientSecret) {
    return null;
  }
  return { tokenEndpoint, userinfoEndpoint, clientId, clientSecret };
}

interface AttemptUpstreamPasswordParams {
  ctx: Context<{ Bindings: Bindings; Variables: Variables }>;
  client: EnrichedClient;
  username: string;
  password: string;
  /**
   * The local DB connection whose `name` is sent as `realm` to upstream Auth0.
   * Must have `options.import_mode: true` to be eligible.
   */
  dbConnection: Connection;
  source: Connection;
  /**
   * The local user, if one already exists. When null, a new user record is
   * created from the `/userinfo` profile on upstream success.
   */
  existingUser: User | null;
}

/**
 * Attempts to verify the supplied password against the upstream Auth0 tenant
 * via the password-realm grant. On success, creates the local user (if
 * missing), stores the bcrypt hash of the password locally, and returns the
 * user. On any failure, returns null — the caller surfaces the existing
 * INVALID_PASSWORD/USER_NOT_FOUND error so the upstream's existence is not
 * leaked to clients.
 *
 * Subsequent logins are served entirely locally because the password row now
 * exists on our side.
 */
export async function attemptUpstreamPasswordFallback(
  params: AttemptUpstreamPasswordParams,
): Promise<User | null> {
  const { ctx, client, username, password, dbConnection, source, existingUser } =
    params;

  if (dbConnection.options?.import_mode !== true) {
    return null;
  }

  const credentials = readAuth0SourceCredentials(source);
  if (!credentials) {
    return null;
  }

  let tokens;
  try {
    tokens = await passwordRealmGrant({
      tokenEndpoint: credentials.tokenEndpoint,
      clientId: credentials.clientId,
      clientSecret: credentials.clientSecret,
      realm: dbConnection.name,
      username,
      password,
    });
  } catch (err) {
    if (err instanceof Auth0UpstreamError) {
      console.warn(
        `Auth0 upstream ROPG failed for tenant=${client.tenant.id} realm=${dbConnection.name}: ${err.code} ${err.description ?? ""}`,
      );
      return null;
    }
    throw err;
  }

  const data = ctx.env.data;
  let user = existingUser;

  if (!user) {
    let profile;
    try {
      profile = await fetchUserInfo(
        credentials.userinfoEndpoint,
        tokens.access_token,
      );
    } catch (err) {
      if (err instanceof Auth0UpstreamError) {
        console.warn(
          `Auth0 upstream userinfo failed for tenant=${client.tenant.id}: ${err.code} ${err.description ?? ""}`,
        );
        return null;
      }
      throw err;
    }

    const usernameLooksLikeEmail = username.includes("@");
    const profileEmail =
      typeof profile.email === "string" ? profile.email : undefined;
    const provider = await resolveUsernamePasswordProvider(
      ctx.env,
      client.tenant.id,
    );
    const userId = `${provider}|${userIdGenerate()}`;

    user = await data.users.create(client.tenant.id, {
      user_id: userId,
      email: profileEmail ?? (usernameLooksLikeEmail ? username : undefined),
      username: usernameLooksLikeEmail ? undefined : username,
      name: typeof profile.name === "string" ? profile.name : username,
      given_name:
        typeof profile.given_name === "string" ? profile.given_name : undefined,
      family_name:
        typeof profile.family_name === "string"
          ? profile.family_name
          : undefined,
      nickname:
        typeof profile.nickname === "string" ? profile.nickname : undefined,
      picture:
        typeof profile.picture === "string" ? profile.picture : undefined,
      email_verified: profile.email_verified === true,
      provider,
      connection: dbConnection.name,
      is_social: false,
      last_ip: ctx.var.ip ?? "",
      last_login: new Date().toISOString(),
      profileData: JSON.stringify(profile),
    });
  }

  const { hash, algorithm } = await hashPassword(password);
  await data.passwords.create(client.tenant.id, {
    user_id: user.user_id,
    password: hash,
    algorithm,
    is_current: true,
  });

  return user;
}
