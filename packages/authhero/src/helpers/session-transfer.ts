import { Context } from "hono";
import { nanoid } from "nanoid";
import { z } from "@hono/zod-openapi";
import {
  DataAdapters,
  LoginSessionState,
  LogTypes,
  RefreshToken,
  Session,
  SessionTransferAuthenticationMethod,
  SessionTransferProvenance,
  User,
  resolveSessionTransfer,
  sessionAuthenticationSchema,
} from "@authhero/adapter-interfaces";
import { Bindings, Variables } from "../types";
import { EnrichedClient } from "./client";
import { logMessage } from "./logging";
import { revokeSessionRefreshTokens } from "./revoke-session-refresh-tokens";
import {
  createLoginSessionWithData,
  readLoginSessionData,
} from "../state-machines/login-session-data";
import { ulid } from "../utils/ulid";
import {
  SESSION_TRANSFER_CODE_TYPE,
  SESSION_TRANSFER_FORWARDED_IP_HEADER,
  SESSION_TRANSFER_TOKEN_TTL_SECONDS,
  generateSessionTransferToken,
  hashSessionTransferToken,
  normalizeIp,
} from "../utils/session-transfer-token";

/**
 * Minting and redeeming session_transfer_tokens (#1710, Auth0 "Native to Web
 * SSO"), and the checks a session or refresh token created from one is subject
 * to afterwards.
 *
 * A token is stored as two rows: a `codes` row keyed by the token's hash, which
 * gives single use and the 60 second lifetime, and a "carrier" login session
 * that holds what the redeeming /authorize needs to rebuild the login: the
 * user, the connection they authenticated with, the device the token is bound
 * to and the refresh token family it was minted from.
 */

type Ctx = Context<{ Bindings: Bindings; Variables: Variables }>;

/**
 * Descriptions of the `w` log written when a presented token does not log the
 * user in. The first five are Auth0's, word for word, so log queries written
 * against Auth0 keep matching. The rest cover checks Auth0 does not make.
 */
export const SESSION_TRANSFER_WARNINGS = {
  notFound:
    "Single Sign-On failed: Session Transfer Token not found or expired. This may indicate token reuse or expiration.",
  deviceBinding:
    "Single Sign-On failed: Session Transfer Token device binding validation failed due to IP/ASN mismatch.",
  organization:
    "Single Sign-On failed: Session Transfer Token organization mismatch detected.",
  userMismatch:
    "Single Sign-On failed: Session Transfer Token user mismatch detected.",
  parentNotFound:
    "Single Sign-On failed: Parent refresh token not found. Session Transfer Token won't be used for session establishment.",
  methodNotAllowed:
    "Single Sign-On failed: Session Transfer Token authentication method is not allowed for this client.",
  connectionNotEnabled:
    "Single Sign-On failed: Session Transfer Token user's connection is not enabled for this client.",
  userUnavailable:
    "Single Sign-On failed: Session Transfer Token user is blocked or no longer exists.",
} as const;

/** What the carrier login session keeps in its context (`state_data`). */
const carrierStateSchema = z.object({
  session_transfer: z.object({
    family_id: z.string(),
    cascade_revocation: z.boolean(),
    asn: z.string().optional(),
    authentication: sessionAuthenticationSchema.optional(),
    organization: z.object({ id: z.string(), name: z.string() }).optional(),
  }),
});

export type SessionTransferCarrierState = z.infer<
  typeof carrierStateSchema
>["session_transfer"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * The autonomous system number of the caller's network, when the runtime
 * reports one (Cloudflare Workers put it on `request.cf.asn`). Undefined
 * everywhere else: the binding check treats that as "cannot verify".
 */
export function getRequestAsn(ctx: Ctx): string | undefined {
  const raw: unknown = ctx.req.raw;
  if (!isRecord(raw) || !isRecord(raw.cf)) return undefined;

  const asn = raw.cf.asn;
  if (typeof asn === "number" && Number.isFinite(asn)) return String(asn);
  if (typeof asn === "string" && asn.trim()) return asn.trim();
  return undefined;
}

function lifetimeToIso(lifetimeHours?: number): string | undefined {
  if (!lifetimeHours) return undefined;
  return new Date(Date.now() + lifetimeHours * 60 * 60 * 1000).toISOString();
}

function sameIp(a: string | undefined, b: string | undefined): boolean {
  const left = normalizeIp(a) ?? a;
  const right = normalizeIp(b) ?? b;
  return !!left && !!right && left === right;
}

/**
 * Whether the client offers the connection a user authenticated with. Names
 * are compared ignoring case, as `getConnectionInfo` does. A user row may hold
 * a bare strategy ("email", "sms") instead of a connection name, so a
 * connection of that strategy counts too, as it does for signup validation.
 */
function isConnectionEnabled(
  client: EnrichedClient,
  connectionName: string,
): boolean {
  const wanted = connectionName.toLowerCase();
  return client.connections.some(
    (connection) =>
      connection.name.toLowerCase() === wanted ||
      connection.strategy === connectionName,
  );
}

export interface MintSessionTransferTokenParams {
  /** The client the refresh token belongs to (the sender). */
  client: EnrichedClient;
  user: User;
  /** The refresh token presented to the exchange, before rotation. */
  refreshToken: RefreshToken;
  sessionId?: string;
  organization?: { id: string; name: string };
  authConnection?: string;
  authStrategy?: RefreshToken["auth_strategy"];
  /**
   * Whether the client proved its identity on this request (secret or
   * assertion). Only then may it name the end user's IP address.
   */
  clientAuthenticated: boolean;
}

/**
 * Mint a session_transfer_token for the user behind a refresh token. The
 * caller has already validated the refresh token and checked that the client
 * may mint. Returns the wire token; only its hash is stored.
 */
export async function mintSessionTransferToken(
  ctx: Ctx,
  params: MintSessionTransferTokenParams,
): Promise<string> {
  const { client, user, refreshToken } = params;
  const data = ctx.env.data;
  const tenantId = client.tenant.id;
  const settings = resolveSessionTransfer(client.session_transfer);

  // An onward transfer (A → B → C) stays tied to the refresh token the chain
  // started from, and stays cascading once any hop asked for it.
  const inherited = refreshToken.session_transfer;
  const familyId =
    inherited?.family_id ?? refreshToken.family_id ?? refreshToken.id;
  const cascadeRevocation =
    settings.enforce_cascade_revocation ||
    (inherited?.cascade_revocation ?? false);

  // The token is bound to the device that will redeem it. That is normally the
  // caller. A backend exchanging on the user's behalf sees its own address, so
  // a confidential client that opted in may forward the user's instead. A
  // public client cannot: anyone can call the exchange as one, and letting
  // them choose the bound address would undo the binding. The client's own
  // registration is checked as well as the request: a public client that
  // happens to send a matching secret is still a public client.
  const forwardedIp =
    settings.trust_forwarded_ip &&
    params.clientAuthenticated &&
    client.token_endpoint_auth_method !== "none"
      ? normalizeIp(ctx.req.header(SESSION_TRANSFER_FORWARDED_IP_HEADER))
      : undefined;
  const boundIp = forwardedIp ?? normalizeIp(ctx.var.ip) ?? ctx.var.ip ?? "";
  // The ASN the runtime reports is the caller's, not the forwarded address's.
  const boundAsn = forwardedIp ? undefined : getRequestAsn(ctx);

  // Carry over how and when the user authenticated, so the transferred login
  // reports the original auth_time and keeps a completed MFA.
  const senderSession = params.sessionId
    ? await data.sessions.get(tenantId, params.sessionId)
    : null;
  // A refresh token outlives its session, so the session may be revoked or
  // expired by now. A completed MFA is only passed on while the session could
  // still vouch for it itself. When the user authenticated stays true either
  // way, and dropping it would make the transferred login look fresher than
  // it is.
  const senderAuthentication = isSessionLive(senderSession)
    ? senderSession.authentication
    : undefined;

  const state: SessionTransferCarrierState = {
    family_id: familyId,
    cascade_revocation: cascadeRevocation,
    asn: boundAsn,
    authentication: senderAuthentication,
    organization: params.organization,
  };

  const now = Date.now();
  const ttlMs = SESSION_TRANSFER_TOKEN_TTL_SECONDS * 1000;

  const carrier = await createLoginSessionWithData(
    data.loginSessions,
    tenantId,
    {
      csrf_token: nanoid(),
      authParams: {
        client_id: client.client_id,
        organization: params.organization?.id,
        scope: refreshToken.resource_servers[0]?.scopes,
      },
      // Outlives the token by a minute so a redemption in the last second
      // still finds it. Creating a session on it extends it like any login
      // session.
      expires_at: new Date(now + ttlMs + 60_000).toISOString(),
      ip: boundIp,
      useragent: ctx.var.useragent,
      state: LoginSessionState.COMPLETED,
      user_id: user.user_id,
      auth_connection: params.authConnection,
      auth_strategy: params.authStrategy,
      authenticated_at: senderSession?.authenticated_at,
    },
    { session_transfer: state },
  );

  const token = generateSessionTransferToken();
  await data.codes.create(tenantId, {
    code_id: await hashSessionTransferToken(token),
    code_type: SESSION_TRANSFER_CODE_TYPE,
    login_id: carrier.id,
    user_id: user.user_id,
    expires_at: new Date(now + ttlMs).toISOString(),
  });

  return token;
}

export interface RedeemSessionTransferTokenParams {
  /** The client the /authorize request is for (the receiver). */
  client: EnrichedClient;
  token: string;
  /** How the token reached /authorize. */
  method: SessionTransferAuthenticationMethod;
  /** The browser's current valid session, if it has one. */
  existingSession?: Session;
  /** The `organization` parameter of the /authorize request (id or name). */
  organization?: string;
}

export type RedeemSessionTransferTokenResult =
  /** The token did not log the user in; continue as if it was not sent. */
  | { outcome: "rejected" }
  /** A new session for the token's user. */
  | { outcome: "session_created"; session: Session }
  /** The browser already had a session for the token's user; it is kept. */
  | { outcome: "session_kept" }
  /** The browser had a session for another user; it has been revoked. */
  | { outcome: "session_revoked" };

/**
 * Redeem a session_transfer_token presented to /authorize. Never throws for an
 * unusable token: every refusal writes a `w` log and reports `rejected`, and
 * the caller carries on with the normal login flow.
 */
export async function redeemSessionTransferToken(
  ctx: Ctx,
  params: RedeemSessionTransferTokenParams,
): Promise<RedeemSessionTransferTokenResult> {
  const { client } = params;
  const data = ctx.env.data;
  const tenantId = client.tenant.id;
  const settings = resolveSessionTransfer(client.session_transfer);

  const reject = (
    description: string,
    userId?: string,
  ): RedeemSessionTransferTokenResult => {
    logMessage(ctx, tenantId, {
      type: LogTypes.WARNING_DURING_LOGIN,
      description,
      userId,
    });
    return { outcome: "rejected" };
  };

  // Checked before the lookup: a client that does not accept tokens this way
  // must not be usable to burn them.
  if (!settings.allowed_authentication_methods.includes(params.method)) {
    return reject(SESSION_TRANSFER_WARNINGS.methodNotAllowed);
  }

  const codeId = await hashSessionTransferToken(params.token);
  const code = await data.codes.get(
    tenantId,
    codeId,
    SESSION_TRANSFER_CODE_TYPE,
  );
  if (
    !code ||
    code.used_at ||
    !code.login_id ||
    new Date(code.expires_at).getTime() <= Date.now()
  ) {
    return reject(SESSION_TRANSFER_WARNINGS.notFound);
  }

  // Consumed before the remaining checks, atomically: a token that fails one
  // of them is spent, and of two concurrent redemptions only one continues.
  if (!(await data.codes.consume(tenantId, codeId))) {
    return reject(SESSION_TRANSFER_WARNINGS.notFound);
  }

  const carrier = await data.loginSessions.get(tenantId, code.login_id);
  // The context is validated, not trusted: a row without a well-formed
  // session_transfer entry is not a carrier.
  const parsedState = carrierStateSchema.safeParse(
    readLoginSessionData(carrier?.state_data),
  );
  const state = parsedState.success
    ? parsedState.data.session_transfer
    : undefined;
  if (!carrier || !state || !carrier.user_id) {
    return reject(SESSION_TRANSFER_WARNINGS.notFound);
  }
  const userId = carrier.user_id;

  const requestAsn = getRequestAsn(ctx);
  if (settings.enforce_device_binding === "ip") {
    if (!sameIp(carrier.ip, ctx.var.ip)) {
      return reject(SESSION_TRANSFER_WARNINGS.deviceBinding, userId);
    }
  } else if (settings.enforce_device_binding === "asn") {
    // Without an ASN on both sides there is nothing to compare, and "cannot
    // verify" must not read as "verified".
    if (!state.asn || !requestAsn || state.asn !== requestAsn) {
      return reject(SESSION_TRANSFER_WARNINGS.deviceBinding, userId);
    }
  }

  if (
    state.organization &&
    params.organization &&
    params.organization !== state.organization.id &&
    params.organization !== state.organization.name
  ) {
    return reject(SESSION_TRANSFER_WARNINGS.organization, userId);
  }

  // The refresh token the token was minted from must still be usable, whether
  // or not the session will keep following it afterwards.
  if (!(await data.refreshTokens.isFamilyActive(tenantId, state.family_id))) {
    return reject(SESSION_TRANSFER_WARNINGS.parentNotFound, userId);
  }

  const user = await data.users.get(tenantId, userId);
  if (!user || user.blocked || user.linked_to) {
    return reject(SESSION_TRANSFER_WARNINGS.userUnavailable, userId);
  }

  // A transfer must not log a user in to an application through a connection
  // that application does not offer.
  if (
    !isConnectionEnabled(client, carrier.auth_connection ?? user.connection)
  ) {
    return reject(SESSION_TRANSFER_WARNINGS.connectionNotEnabled, userId);
  }

  const { existingSession } = params;
  if (existingSession) {
    if (existingSession.user_id === user.user_id) {
      // Already logged in as this user: the existing session wins and is not
      // tied to the token's parent.
      return { outcome: "session_kept" };
    }

    // Another user's session on this browser. Silently swapping accounts is
    // what a login CSRF wants, so neither session survives and the user logs
    // in again.
    const revokedAt = new Date().toISOString();
    await data.sessions.update(tenantId, existingSession.id, {
      revoked_at: revokedAt,
    });
    await revokeSessionRefreshTokens(
      data,
      tenantId,
      existingSession,
      revokedAt,
    );
    logMessage(ctx, tenantId, {
      type: LogTypes.WARNING_DURING_LOGIN,
      description: SESSION_TRANSFER_WARNINGS.userMismatch,
      userId,
    });
    return { outcome: "session_revoked" };
  }

  const senderClientId = carrier.authParams.client_id;
  const asn = requestAsn ?? "";
  const provenance: SessionTransferProvenance = {
    client_id: senderClientId,
    family_id: state.family_id,
    cascade_revocation: state.cascade_revocation,
  };

  let session = await data.sessions.create(tenantId, {
    id: ulid(),
    user_id: user.user_id,
    login_session_id: carrier.id,
    idle_expires_at: lifetimeToIso(client.tenant.idle_session_lifetime),
    expires_at: lifetimeToIso(client.tenant.session_lifetime),
    device: {
      last_ip: ctx.var.ip || "",
      initial_ip: ctx.var.ip || "",
      last_user_agent: ctx.var.useragent || "",
      initial_user_agent: ctx.var.useragent || "",
      initial_asn: asn,
      last_asn: asn,
    },
    clients: [client.client_id],
    authentication: state.authentication,
    session_transfer: provenance,
  });

  // The user authenticated when the sender's session did, not now: `max_age`
  // and `auth_time` on the receiving side have to see that.
  if (carrier.authenticated_at) {
    await data.sessions.update(tenantId, session.id, {
      authenticated_at: carrier.authenticated_at,
    });
    session = { ...session, authenticated_at: carrier.authenticated_at };
  }

  ctx.set("session_transfer_token", {
    client_id: senderClientId,
    scope: carrier.authParams.scope,
    request: {
      ip: carrier.ip ?? "",
      asn: state.asn,
      user_agent: carrier.useragent,
    },
  });

  return { outcome: "session_created", session };
}

/**
 * Whether the refresh token a transferred session or refresh token descends
 * from is still usable. Only call this for rows that carry provenance with
 * `cascade_revocation`, so ordinary logins pay nothing for it.
 */
export function isSessionTransferParentActive(
  data: DataAdapters,
  tenantId: string,
  provenance: SessionTransferProvenance,
): Promise<boolean> {
  return data.refreshTokens.isFamilyActive(tenantId, provenance.family_id);
}

/**
 * Whether a session can still back an "online" refresh token: it exists, has
 * not been revoked and has not passed its absolute or idle expiry.
 */
export function isSessionLive(
  session: Session | null | undefined,
  now: number = Date.now(),
): session is Session {
  if (!session || session.revoked_at) return false;
  if (session.expires_at && new Date(session.expires_at).getTime() <= now) {
    return false;
  }
  if (
    session.idle_expires_at &&
    new Date(session.idle_expires_at).getTime() <= now
  ) {
    return false;
  }
  return true;
}

/** How far the idle expiry must move before it is worth a `sessions` write. */
const ONLINE_SESSION_IDLE_SLIDE_THROTTLE_MS = 5 * 60 * 1000;

/**
 * The idle expiry a session should move to after one of its online refresh
 * tokens was exchanged, or undefined when it should be left alone. Exchanging
 * the token is the only sign of life such a session gets from an application
 * that never returns to /authorize, so without the slide the session, and the
 * refresh token bound to it, would end after one idle period however active
 * the user is. Never moves past the session's absolute expiry.
 */
export function nextOnlineSessionIdleExpiry(
  client: EnrichedClient,
  session: Pick<Session, "idle_expires_at" | "expires_at">,
  now: number = Date.now(),
): string | undefined {
  const idleHours = client.tenant.idle_session_lifetime;
  if (!idleHours || !session.idle_expires_at) return undefined;

  const idleMs = idleHours * 60 * 60 * 1000;
  let next = now + idleMs;
  if (session.expires_at) {
    next = Math.min(next, new Date(session.expires_at).getTime());
  }

  // With an idle period shorter than the throttle the expiry could never move
  // far enough to pass it, and the session would end however active it is.
  const throttleMs = Math.min(
    ONLINE_SESSION_IDLE_SLIDE_THROTTLE_MS,
    idleMs / 2,
  );
  const current = new Date(session.idle_expires_at).getTime();
  if (next - current < throttleMs) return undefined;
  return new Date(next).toISOString();
}

export type TransferredRefreshTokenPolicy =
  | { allowed: false }
  | {
      allowed: true;
      session_transfer?: SessionTransferProvenance;
      /** Absolute expiry the refresh token may not outlive. */
      max_expires_at?: string;
    };

/**
 * What applies to a refresh token about to be issued under `session`. A
 * session that did not come from a session_transfer_token is unaffected. One
 * that did gets a refresh token only if the client opted in, and that token
 * records where it came from and, unless the client turned it off, ends with
 * the session ("online" refresh token).
 */
export function resolveTransferredRefreshTokenPolicy(
  client: EnrichedClient,
  session: Pick<Session, "session_transfer" | "expires_at"> | null | undefined,
): TransferredRefreshTokenPolicy {
  const provenance = session?.session_transfer;
  if (!provenance) return { allowed: true };

  const settings = resolveSessionTransfer(client.session_transfer);
  if (!settings.allow_refresh_token) return { allowed: false };

  return {
    allowed: true,
    session_transfer: provenance,
    max_expires_at: settings.enforce_online_refresh_tokens
      ? session?.expires_at
      : undefined,
  };
}
