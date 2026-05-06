import { jwksSchema, DataAdapters } from "@authhero/adapter-interfaces";
import { X509Certificate } from "@peculiar/x509";
import { algForJwk } from "./jwk-alg";

/**
 * Helper function to fetch JWKS keys from the database
 * This can be used when JWKS_URL is not available or when running outside Cloudflare
 */
export async function getJwksFromDatabase(data: DataAdapters) {
  const { signingKeys } = await data.keys.list({
    q: "type:jwt_signing",
  });
  const keys = await Promise.all(
    signingKeys.map(async (signingKey: any) => {
      const importedCert = new X509Certificate(signingKey.cert);
      const publicKey = await importedCert.publicKey.export();
      const jwkKey = (await crypto.subtle.exportKey(
        "jwk",
        publicKey,
      )) as JsonWebKey & { kty: string };

      // WebCrypto omits `alg` from EC JWKs; derive it from kty + crv so the
      // published JWKS lets clients verify without guessing.
      const alg = jwkKey.alg ?? algForJwk(jwkKey);

      return jwksSchema.parse({
        ...jwkKey,
        alg,
        use: "sig",
        kid: signingKey.kid,
      });
    }),
  );

  return keys;
}
