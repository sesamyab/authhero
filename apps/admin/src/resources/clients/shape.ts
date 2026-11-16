import { isCimdClient } from "./cimd";

type ClientLike = {
  app_type?: string;
  client_metadata?: Record<string, unknown> | null;
  grant_types?: string[] | null;
  token_endpoint_auth_method?: string | null;
  addons?: { samlp?: unknown } | null;
};

export type ClientShape = {
  // Whether the client authenticates with a secret (vs. PKCE/public).
  showSecret: boolean;
  // Whether the client makes user-agent (browser/native) redirects.
  showCallbacks: boolean;
  // Whether users log in through this client: login-screen settings, the
  // Connections, Organizations, Refresh Tokens and Session Transfer tabs, and
  // the Login button.
  isInteractive: boolean;
  // Whether the SAML addon (SSO tab) applies.
  showSso: boolean;
  // Whether the client can call APIs on its own behalf (Client Grants tab).
  showClientGrants: boolean;
  // Whether the client is externally managed (CIMD / DCR) and locally edited
  // fields will be overwritten.
  isExternallyManaged: boolean;
};

// Mirrors Auth0's app-type model: SPA and Native are public (no secret, no
// confidential grants); Machine-to-Machine has no user agent so no callbacks,
// connections or refresh tokens apply; Regular Web is the conventional
// confidential interactive client. app_type picks the layout, but sections
// backed by what the token endpoint actually enforces (grant_types) or by
// data already on the record stay visible so nothing active is hidden.
export function getClientShape(record: ClientLike | undefined): ClientShape {
  const hasClientCredentials =
    record?.grant_types?.includes("client_credentials") ?? false;
  const hasSamlAddon = record?.addons?.samlp != null;
  // An SPA or Native record can still carry a secret-based auth method (e.g.
  // the old client_secret_basic default); client_credentials then works, so
  // its grants must stay reviewable.
  const canUseClientCredentials =
    hasClientCredentials && record?.token_endpoint_auth_method !== "none";

  if (isCimdClient(record)) {
    return {
      showSecret: false,
      showCallbacks: true,
      isInteractive: true,
      showSso: hasSamlAddon,
      showClientGrants: false,
      isExternallyManaged: true,
    };
  }
  switch (record?.app_type) {
    case "spa":
      return {
        showSecret: false,
        showCallbacks: true,
        isInteractive: true,
        showSso: true,
        showClientGrants: canUseClientCredentials,
        isExternallyManaged: false,
      };
    case "native":
      return {
        showSecret: false,
        showCallbacks: true,
        isInteractive: true,
        showSso: hasSamlAddon,
        showClientGrants: canUseClientCredentials,
        isExternallyManaged: false,
      };
    case "non_interactive":
      return {
        showSecret: true,
        showCallbacks: false,
        isInteractive: false,
        showSso: hasSamlAddon,
        showClientGrants: true,
        isExternallyManaged: false,
      };
    default:
      return {
        showSecret: true,
        showCallbacks: true,
        isInteractive: true,
        showSso: true,
        showClientGrants: hasClientCredentials,
        isExternallyManaged: false,
      };
  }
}
