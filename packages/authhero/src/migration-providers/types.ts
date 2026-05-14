import { MigrationSource } from "@authhero/adapter-interfaces";

export interface UpstreamTokenResponse {
  access_token: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
}

export interface UpstreamUserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  given_name?: string;
  family_name?: string;
  nickname?: string;
  picture?: string;
  locale?: string;
  [key: string]: unknown;
}

export interface MigrationProvider {
  /**
   * Redeem an upstream refresh token at the IdP and return its access token
   * (and optionally id_token). Throws if the upstream rejects the token.
   */
  exchangeRefreshToken(refreshToken: string): Promise<UpstreamTokenResponse>;
  /**
   * Fetch profile info using the upstream access token. Returns at minimum the
   * upstream `sub` so we can resolve or lazily create the local user.
   */
  fetchUserInfo(accessToken: string): Promise<UpstreamUserInfo>;
}

export type MigrationProviderFactory = (
  source: MigrationSource,
) => MigrationProvider;
