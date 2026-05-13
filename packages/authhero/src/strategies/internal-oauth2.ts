import { OAuth2Client, OAuth2Tokens, OAuth2RequestError } from "arctic";

/**
 * Extends arctic's `OAuth2Client` to support `client_secret_post` at the token
 * endpoint. Arctic only supports `client_secret_basic` (HTTP Basic), which is
 * rejected by providers like JumpCloud that require POST-body credentials.
 *
 * The auth-URL builder, PKCE handling, and `OAuth2Tokens` shape are inherited
 * unchanged. Only `validateAuthorizationCode` is overridden — and only when
 * `client_secret_post` is requested with a non-null client password.
 */
export type TokenEndpointAuthMethod =
  | "client_secret_basic"
  | "client_secret_post";

export class ExtendedOAuth2Client extends OAuth2Client {
  // Arctic marks its fields as private in d.ts, so we track our own copies for
  // the override path. The base class still has the same values for its own
  // basic-auth path via super().
  private readonly _clientId: string;
  private readonly _clientPassword: string | null;
  private readonly _redirectURI: string | null;
  private readonly tokenEndpointAuthMethod: TokenEndpointAuthMethod;

  constructor(
    clientId: string,
    clientPassword: string | null,
    redirectURI: string | null,
    tokenEndpointAuthMethod: TokenEndpointAuthMethod = "client_secret_basic",
  ) {
    super(clientId, clientPassword, redirectURI);
    this._clientId = clientId;
    this._clientPassword = clientPassword;
    this._redirectURI = redirectURI;
    this.tokenEndpointAuthMethod = tokenEndpointAuthMethod;
  }

  async validateAuthorizationCode(
    tokenEndpoint: string,
    code: string,
    codeVerifier: string | null,
  ): Promise<OAuth2Tokens> {
    if (
      this._clientPassword === null ||
      this.tokenEndpointAuthMethod === "client_secret_basic"
    ) {
      return super.validateAuthorizationCode(
        tokenEndpoint,
        code,
        codeVerifier,
      );
    }

    const body = new URLSearchParams();
    body.set("grant_type", "authorization_code");
    body.set("code", code);
    if (this._redirectURI !== null) {
      body.set("redirect_uri", this._redirectURI);
    }
    if (codeVerifier !== null) {
      body.set("code_verifier", codeVerifier);
    }
    body.set("client_id", this._clientId);
    body.set("client_secret", this._clientPassword);

    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new Error(
        `Token endpoint returned non-JSON response (${response.status})`,
      );
    }

    if (typeof data !== "object" || data === null) {
      throw new Error(
        `Token endpoint returned unexpected body (${response.status})`,
      );
    }

    if (response.status >= 400) {
      const err = data as { error?: unknown; error_description?: unknown };
      const errorCode =
        typeof err.error === "string" ? err.error : `http_${response.status}`;
      const description =
        typeof err.error_description === "string"
          ? err.error_description
          : null;
      throw new OAuth2RequestError(errorCode, description, null, null);
    }

    return new OAuth2Tokens(data as Record<string, unknown>);
  }
}
