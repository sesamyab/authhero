/**
 * Thrown by the refresh-token grant when a request is proxied verbatim to an
 * upstream Auth0 tenant. The token route catches it and relays the
 * (status, body) pair to the client unchanged so behaviour matches Auth0
 * (rotation, error shapes, scope echoes, etc.) byte-for-byte.
 *
 * This is not a HTTP error — it is a control-flow signal that bypasses the
 * normal token-minting pipeline. We use a thrown class to keep the grant
 * function's return type unchanged (`GrantFlowResult`) and to make the
 * short-circuit visible at every call site.
 */
export class Auth0ProxyResponse extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super("Auth0 upstream response proxied");
    this.name = "Auth0ProxyResponse";
    this.status = status;
    this.body = body;
  }
}
