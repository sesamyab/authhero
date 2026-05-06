import { X509Certificate } from "@peculiar/x509";

export type SupportedAlg =
  | "RS256"
  | "RS384"
  | "RS512"
  | "ES256"
  | "ES384"
  | "ES512";

const EC_CURVE_TO_ALG: Record<string, SupportedAlg> = {
  "P-256": "ES256",
  "P-384": "ES384",
  "P-521": "ES512",
};

const EC_CURVE_TO_HASH: Record<string, string> = {
  "P-256": "SHA-256",
  "P-384": "SHA-384",
  "P-521": "SHA-512",
};

const RSA_HASH_BY_ALG: Record<string, string> = {
  RS256: "SHA-256",
  RS384: "SHA-384",
  RS512: "SHA-512",
};

export function algForJwk(jwk: { kty: string; crv?: string }): SupportedAlg {
  if (jwk.kty === "RSA") {
    return "RS256";
  }
  if (jwk.kty === "EC") {
    if (!jwk.crv || !(jwk.crv in EC_CURVE_TO_ALG)) {
      throw new Error(`Unsupported EC curve: ${jwk.crv ?? "(missing)"}`);
    }
    return EC_CURVE_TO_ALG[jwk.crv]!;
  }
  throw new Error(`Unsupported JWK kty: ${jwk.kty}`);
}

export function importParamsForJwk(
  jwk: { kty: string; crv?: string },
  alg: string,
): RsaHashedImportParams | EcKeyImportParams {
  if (jwk.kty === "RSA") {
    const hash = RSA_HASH_BY_ALG[alg];
    if (!hash) {
      throw new Error(`Unsupported RSA alg: ${alg}`);
    }
    return { name: "RSASSA-PKCS1-v1_5", hash };
  }
  if (jwk.kty === "EC") {
    if (!jwk.crv || !(jwk.crv in EC_CURVE_TO_HASH)) {
      throw new Error(`Unsupported EC curve: ${jwk.crv ?? "(missing)"}`);
    }
    return { name: "ECDSA", namedCurve: jwk.crv };
  }
  throw new Error(`Unsupported JWK kty: ${jwk.kty}`);
}

/**
 * The set of `id_token_signing_alg_values_supported` we currently advertise.
 * Derived from the algorithms we can actually issue + verify.
 */
export const SUPPORTED_ID_TOKEN_SIGNING_ALGS: SupportedAlg[] = [
  "RS256",
  "ES256",
  "ES384",
  "ES512",
];

/**
 * Derive the JWS signing algorithm to use with a signing key, by inspecting
 * the public-key material embedded in its X.509 cert.
 */
export async function algForCert(certPem: string): Promise<SupportedAlg> {
  const cert = new X509Certificate(certPem);
  const publicKey = await cert.publicKey.export();
  const jwk = (await crypto.subtle.exportKey(
    "jwk",
    publicKey,
  )) as JsonWebKey & { kty: string };
  return algForJwk(jwk);
}
