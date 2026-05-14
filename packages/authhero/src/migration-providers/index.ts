import { MigrationSource } from "@authhero/adapter-interfaces";
import { createAuth0Provider } from "./auth0";
import { MigrationProvider } from "./types";

export { Auth0UpstreamError } from "../utils/auth0-upstream";
export type {
  MigrationProvider,
  UpstreamTokenResponse,
  UpstreamUserInfo,
} from "./types";

export function createMigrationProvider(
  source: MigrationSource,
): MigrationProvider {
  switch (source.provider) {
    case "auth0":
      return createAuth0Provider(source);
    case "cognito":
    case "okta":
    case "oidc":
      throw new Error(
        `Migration provider "${source.provider}" is not implemented yet`,
      );
    default: {
      const exhaustive: never = source.provider;
      throw new Error(`Unknown migration provider: ${String(exhaustive)}`);
    }
  }
}
