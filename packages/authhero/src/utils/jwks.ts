import {
  jwksSchema,
  DataAdapters,
  SigningKey,
} from "@authhero/adapter-interfaces";
import { X509Certificate } from "@peculiar/x509";
import { algForJwk } from "./jwk-alg";
import { resolveSigningKeys } from "../helpers/signing-keys";
import { SigningKeyModeOption } from "../types/AuthHeroConfig";

async function signingKeysToJwks(signingKeys: SigningKey[]) {
  return Promise.all(
    signingKeys.map(async (signingKey) => {
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
}

/**
 * Helper function to fetch JWKS keys from the database for token *verification*.
 *
 * Returns every non-revoked `jwt_signing` key regardless of tenant scope so a
 * token signed by any key (control-plane or any tenant) can be matched by kid.
 * Use `getJwksForPublication` for the public `/.well-known/jwks.json` endpoint.
 */
export async function getJwksFromDatabase(data: DataAdapters) {
  const { signingKeys } = await data.keys.list({
    q: "type:jwt_signing",
  });
  return signingKeysToJwks(signingKeys);
}

/**
 * JWKS for publication on a tenant's `/.well-known/jwks.json`. Honors the
 * configured `signingKeyMode` and, in `"tenant"` mode, returns the union of
 * the tenant's keys and the control-plane fallback so tokens signed by either
 * still verify during the per-tenant key rollout.
 */
export async function getJwksForPublication(
  data: DataAdapters,
  tenantId: string,
  modeOption: SigningKeyModeOption | undefined,
) {
  const signingKeys = await resolveSigningKeys(
    data.keys,
    tenantId,
    modeOption,
    { purpose: "publish" },
  );
  return signingKeysToJwks(signingKeys);
}
