import { SamlSignatureVerifier } from "../verifier";

const DSIG_NS = "http://www.w3.org/2000/09/xmldsig#";

/**
 * Signature verifier backed by xml-crypto. Runs on Node.js and on Cloudflare
 * Workers with the `nodejs_compat` flag. xml-crypto and @xmldom/xmldom are
 * loaded on first use, so importing this class costs nothing at startup.
 *
 * Only the certificates passed in are trusted: xml-crypto ignores the
 * message's KeyInfo unless told otherwise, and HMAC algorithms stay disabled.
 */
export class LocalSamlVerifier implements SamlSignatureVerifier {
  async verifySignedReferences(
    xml: string,
    certificates: string[],
  ): Promise<string[]> {
    let xmlCrypto: typeof import("xml-crypto");
    let xmldom: typeof import("@xmldom/xmldom");
    try {
      [xmlCrypto, xmldom] = await Promise.all([
        import("xml-crypto"),
        import("@xmldom/xmldom"),
      ]);
    } catch (error) {
      throw new Error(
        `LocalSamlVerifier needs the xml-crypto and @xmldom/xmldom packages: ${error}`,
      );
    }
    // Both are CommonJS; handle default-export interop.
    const SignedXml =
      xmlCrypto.SignedXml ??
      (xmlCrypto as unknown as { default: typeof xmlCrypto }).default.SignedXml;
    const DOMParser =
      xmldom.DOMParser ??
      (xmldom as unknown as { default: typeof xmldom }).default.DOMParser;

    const doc = new DOMParser().parseFromString(xml, "text/xml");
    const nodeList = doc.getElementsByTagNameNS(DSIG_NS, "Signature");
    const signatures: Array<NonNullable<ReturnType<typeof nodeList.item>>> = [];
    for (let i = 0; i < nodeList.length; i++) {
      const node = nodeList.item(i);
      if (node) signatures.push(node);
    }

    const signed: string[] = [];
    for (const signatureNode of signatures) {
      let lastError: unknown;
      let verified = false;
      for (const publicCert of certificates) {
        const sig = new SignedXml({ publicCert });
        try {
          sig.loadSignature(signatureNode);
          if (sig.checkSignature(xml)) {
            signed.push(...sig.getSignedReferences());
            verified = true;
            break;
          }
          lastError = new Error("signature references did not validate");
        } catch (error) {
          lastError = error;
        }
      }
      if (!verified) {
        throw new Error(
          `signature did not validate against any configured certificate: ${
            lastError instanceof Error ? lastError.message : String(lastError)
          }`,
        );
      }
    }
    return signed;
  }
}
