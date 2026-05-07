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

const RSA_HASH_BY_ALG: Record<string, string> = {
  RS256: "SHA-256",
  RS384: "SHA-384",
  RS512: "SHA-512",
};

const SUPPORTED_ALG_SET = new Set<SupportedAlg>([
  "RS256",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
  "ES512",
]);

function isSupportedAlg(alg: unknown): alg is SupportedAlg {
  return typeof alg === "string" && SUPPORTED_ALG_SET.has(alg as SupportedAlg);
}

export function algForJwk(jwk: {
  kty: string;
  crv?: string;
  alg?: string;
}): SupportedAlg {
  // If the JWK declares its own alg, respect it (RFC 7517 §4.4) — otherwise an
  // RSA key registered as RS384/RS512 would be silently downgraded to RS256.
  if (isSupportedAlg(jwk.alg)) {
    if (jwk.kty === "RSA" && jwk.alg.startsWith("RS")) return jwk.alg;
    if (jwk.kty === "EC" && jwk.alg.startsWith("ES")) {
      const expected =
        jwk.crv && jwk.crv in EC_CURVE_TO_ALG
          ? EC_CURVE_TO_ALG[jwk.crv]
          : undefined;
      if (expected && expected !== jwk.alg) {
        throw new Error(
          `EC alg/curve mismatch: curve ${jwk.crv} requires ${expected}, got ${jwk.alg}`,
        );
      }
      return jwk.alg;
    }
  }
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
    if (!jwk.crv || !(jwk.crv in EC_CURVE_TO_ALG)) {
      throw new Error(`Unsupported EC curve: ${jwk.crv ?? "(missing)"}`);
    }
    const expectedAlg = EC_CURVE_TO_ALG[jwk.crv];
    if (alg !== expectedAlg) {
      throw new Error(
        `EC alg/curve mismatch: curve ${jwk.crv} requires ${expectedAlg}, got ${alg}`,
      );
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
