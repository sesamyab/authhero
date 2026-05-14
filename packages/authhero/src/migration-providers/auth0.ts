import { MigrationSource } from "@authhero/adapter-interfaces";
import {
  fetchUserInfo,
  upstreamRefreshTokenGrant,
} from "../utils/auth0-upstream";
import {
  MigrationProvider,
  UpstreamTokenResponse,
  UpstreamUserInfo,
} from "./types";

function endpointsFor(domain: string): {
  tokenEndpoint: string;
  userinfoEndpoint: string;
} {
  const base = domain.startsWith("http") ? domain : `https://${domain}`;
  const normalized = base.replace(/\/+$/, "");
  return {
    tokenEndpoint: `${normalized}/oauth/token`,
    userinfoEndpoint: `${normalized}/userinfo`,
  };
}

export function createAuth0Provider(
  source: MigrationSource,
): MigrationProvider {
  const { tokenEndpoint, userinfoEndpoint } = endpointsFor(
    source.credentials.domain,
  );

  return {
    async exchangeRefreshToken(
      refreshToken: string,
    ): Promise<UpstreamTokenResponse> {
      const tokens = await upstreamRefreshTokenGrant({
        tokenEndpoint,
        clientId: source.credentials.client_id,
        clientSecret: source.credentials.client_secret,
        refreshToken,
        audience: source.credentials.audience,
        scope: source.credentials.scope,
      });
      return {
        access_token: tokens.access_token,
        id_token: tokens.id_token,
        expires_in: tokens.expires_in,
        scope: tokens.scope,
      };
    },
    async fetchUserInfo(accessToken: string): Promise<UpstreamUserInfo> {
      return fetchUserInfo(userinfoEndpoint, accessToken);
    },
  };
}
