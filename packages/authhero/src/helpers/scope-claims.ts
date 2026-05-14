import type { User } from "@authhero/adapter-interfaces";

// OIDC Core 5.4 standard-claim-to-scope mapping. Returned claims are merged
// into the userinfo response and — for any flow that issues an ID Token at
// the authorization endpoint (Implicit / Hybrid) — into the ID Token, which
// is what the OIDF check `VerifyScopesReturnedInAuthorizationEndpointIdToken`
// asserts. Caller is responsible for adding `sub` (and anything else not
// driven by scope, like `email_verified` semantics).
//
// Conventions:
// - Values are omitted when the underlying user attribute is null/undefined/
//   empty so the suite doesn't flag explicit `null`s as "extra claims."
// - `email_verified` and `phone_number_verified` are emitted whenever the
//   underlying boolean is set, regardless of value (including `false`).
// - `preferred_username` falls back to `username` for back-compat with users
//   created before the dedicated `preferred_username` field existed.

// Pulls a single OIDC Core 5.1 standard claim from a User row. Returns
// `undefined` when the underlying attribute is missing (so callers can
// spread the result without emitting explicit nulls). Shared by
// buildScopeClaims and buildRequestedClaims (OIDC Core 5.5 `claims`
// request parameter) so the two paths stay in lockstep.
export function getStandardClaim(
  user: User,
  claim: string,
): unknown | undefined {
  switch (claim) {
    case "email":
      return user.email || undefined;
    case "email_verified":
      return user.email_verified !== undefined
        ? user.email_verified
        : undefined;
    case "name":
      return user.name || undefined;
    case "family_name":
      return user.family_name || undefined;
    case "given_name":
      return user.given_name || undefined;
    case "middle_name":
      return user.middle_name || undefined;
    case "nickname":
      return user.nickname || undefined;
    case "preferred_username":
      return user.preferred_username || user.username || undefined;
    case "profile":
      return user.profile || undefined;
    case "picture":
      return user.picture || undefined;
    case "website":
      return user.website || undefined;
    case "gender":
      return user.gender || undefined;
    case "birthdate":
      return user.birthdate || undefined;
    case "zoneinfo":
      return user.zoneinfo || undefined;
    case "locale":
      return user.locale || undefined;
    case "updated_at": {
      if (!user.updated_at) return undefined;
      const ts = new Date(user.updated_at).getTime();
      return Number.isFinite(ts) ? Math.floor(ts / 1000) : undefined;
    }
    case "address":
      return user.address || undefined;
    case "phone_number":
      return user.phone_number || undefined;
    // `phone_number_verified` is the OIDC standard claim name; we store it
    // internally as `phone_verified`.
    case "phone_number_verified":
      return user.phone_verified !== undefined
        ? user.phone_verified
        : undefined;
    default:
      return undefined;
  }
}

const SCOPE_TO_CLAIMS: Record<string, readonly string[]> = {
  email: ["email", "email_verified"],
  profile: [
    "name",
    "family_name",
    "given_name",
    "middle_name",
    "nickname",
    "preferred_username",
    "profile",
    "picture",
    "website",
    "gender",
    "birthdate",
    "zoneinfo",
    "locale",
    "updated_at",
  ],
  address: ["address"],
  phone: ["phone_number", "phone_number_verified"],
};

export function buildScopeClaims(
  user: User,
  scopes: string[],
): Record<string, unknown> {
  const claims: Record<string, unknown> = {};
  for (const scope of scopes) {
    const claimNames = SCOPE_TO_CLAIMS[scope];
    if (!claimNames) continue;
    for (const name of claimNames) {
      const value = getStandardClaim(user, name);
      if (value !== undefined) claims[name] = value;
    }
  }
  return claims;
}

// OIDC Core 5.5 — additively emit standard claims requested via the `claims`
// parameter, regardless of scope. The spec lets the OP ignore non-essential
// requests and even ignore essentials it can't satisfy; we use the
// "include-if-available" policy because the conformance suite's
// `oidcc-claims-essential` test asserts presence.
export function buildRequestedClaims(
  user: User,
  claimNames: Iterable<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of claimNames) {
    const value = getStandardClaim(user, name);
    if (value !== undefined) out[name] = value;
  }
  return out;
}
