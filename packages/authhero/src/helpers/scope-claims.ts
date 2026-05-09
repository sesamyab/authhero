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
export function buildScopeClaims(
  user: User,
  scopes: string[],
): Record<string, unknown> {
  const claims: Record<string, unknown> = {};

  if (scopes.includes("email")) {
    if (user.email) claims.email = user.email;
    if (user.email_verified !== undefined) {
      claims.email_verified = user.email_verified;
    }
  }

  if (scopes.includes("profile")) {
    if (user.name) claims.name = user.name;
    if (user.family_name) claims.family_name = user.family_name;
    if (user.given_name) claims.given_name = user.given_name;
    if (user.middle_name) claims.middle_name = user.middle_name;
    if (user.nickname) claims.nickname = user.nickname;
    const preferredUsername = user.preferred_username || user.username;
    if (preferredUsername) claims.preferred_username = preferredUsername;
    if (user.profile) claims.profile = user.profile;
    if (user.picture) claims.picture = user.picture;
    if (user.website) claims.website = user.website;
    if (user.gender) claims.gender = user.gender;
    if (user.birthdate) claims.birthdate = user.birthdate;
    if (user.zoneinfo) claims.zoneinfo = user.zoneinfo;
    if (user.locale) claims.locale = user.locale;
    if (user.updated_at) {
      claims.updated_at = Math.floor(
        new Date(user.updated_at).getTime() / 1000,
      );
    }
  }

  if (scopes.includes("address")) {
    if (user.address) claims.address = user.address;
  }

  if (scopes.includes("phone")) {
    if (user.phone_number) claims.phone_number = user.phone_number;
    // `phone_number_verified` is the OIDC standard claim name; we store it
    // internally as `phone_verified`.
    if (user.phone_verified !== undefined) {
      claims.phone_number_verified = user.phone_verified;
    }
  }

  return claims;
}
