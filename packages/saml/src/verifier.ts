/**
 * Verifies the XML-DSig signatures of a SAML message.
 *
 * Kept as an interface so the core package stays free of xml-crypto: pass
 * `LocalSamlVerifier` (from `@authhero/saml/local-verifier`, xml-crypto
 * based, runs on Node and on Cloudflare Workers with `nodejs_compat`) or a
 * custom implementation to `init({ samlVerifier })`.
 */
export interface SamlSignatureVerifier {
  /**
   * Validates every `ds:Signature` in `xml` against the trusted
   * `certificates` (PEM). Must ignore any certificate embedded in the
   * message's own KeyInfo.
   *
   * @returns the canonical XML of every element covered by a valid
   *   signature — only this content may be trusted. An empty array means the
   *   message carries no signature.
   * @throws when a signature is present but does not validate against any of
   *   the certificates.
   */
  verifySignedReferences(
    xml: string,
    certificates: string[],
  ): Promise<string[]>;
}
