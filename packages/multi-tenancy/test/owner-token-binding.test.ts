import { beforeEach, describe, expect, it } from "vitest";
import createAdapters from "@authhero/kysely-adapter";
import { encodeBase64Url } from "@authhero/adapter-interfaces";
import { init, MANAGEMENT_API_AUDIENCE } from "authhero";
import { initMultiTenant } from "../src/init";
import { DEFAULT_SELF_SERVICE_ROLE_NAME } from "../src/hooks/self-service-signup";
import { createMigratedDb } from "./helpers/migrated-db";

const CP = "control_plane";
const ISSUER = "https://auth.example.com/";
const OWNER = "auth2|owner";

function pemToDer(pem: string): ArrayBuffer {
  const base64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;
}

async function signRs256(
  pkcs8Pem: string,
  kid: string,
  claims: Record<string, unknown>,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pkcs8Pem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const encode = (value: unknown) =>
    encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  const input = `${encode({ alg: "RS256", typ: "JWT", kid })}.${encode(claims)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${encodeBase64Url(new Uint8Array(signature))}`;
}

/**
 * A tenant owner's control-plane token is organization-scoped: `tenant_id` is
 * the control plane, `org_name` (or `org_id`) is their tenant. It carries the
 * owner role's permissions, so it must only work for that tenant.
 */
describe("a tenant owner's organization-scoped token, through initMultiTenant", () => {
  let data: ReturnType<typeof createAdapters>;
  let ownerRoleId: string;
  let orgId: string;
  let permissions: string[];
  let call: (
    claims: Record<string, unknown>,
    tenantId: string,
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<Response>;

  beforeEach(async () => {
    data = createAdapters(await createMigratedDb());
    await data.tenants.create({
      id: CP,
      friendly_name: CP,
      audience: "https://control-plane.example.com",
      sender_email: "admin@example.com",
      sender_name: CP,
    });
    const { createX509Certificate } = init({ dataAdapter: data });
    const signingKey = await createX509Certificate({ name: "CN=test" });
    await data.keys.create({ ...signingKey, type: "jwt_signing" });
    const { app } = initMultiTenant({
      dataAdapter: data,
      controlPlane: { tenantId: CP, clientId: "control-plane-client" },
    });
    const env = {
      ISSUER,
      AUTH_URL: "https://auth.example.com",
      ENVIRONMENT: "test",
    };
    call = async (claims, tenantId, method, path, body) => {
      const now = Math.floor(Date.now() / 1000);
      const token = await signRs256(signingKey.pkcs7!, signingKey.kid, {
        iss: ISSUER,
        aud: MANAGEMENT_API_AUDIENCE,
        tenant_id: CP,
        iat: now,
        exp: now + 3600,
        ...claims,
      });
      return app.request(
        path,
        {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "tenant-id": tenantId,
            "content-type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        env,
      );
    };

    // Two self-service creators make their tenants through the real flow, so
    // the organizations and the owner role are the real ones, and there is a
    // tenant that is not the owner's.
    const selfService = await data.roles.create(CP, {
      name: DEFAULT_SELF_SERVICE_ROLE_NAME,
    });
    for (const [user, tenant] of [
      [OWNER, "acme"],
      ["auth2|other", "globex"],
    ]) {
      await data.users.create(CP, {
        user_id: user,
        email: `${user.replace("|", "-")}@example.com`,
        email_verified: true,
        provider: "auth2",
        connection: "Username-Password-Authentication",
        is_social: false,
      });
      await data.userRoles.create(CP, user, selfService.id, "");
      const response = await call(
        { sub: user, permissions: ["create:tenants"] },
        CP,
        "POST",
        "/api/v2/tenants",
        { id: tenant, friendly_name: tenant },
      );
      expect(response.status).toBe(201);
    }

    ownerRoleId = (await data.roles.list(CP, {})).roles.find(
      (r) => r.name === "Tenant Owner",
    )!.id;
    orgId = (await data.organizations.list(CP)).organizations.find(
      (o) => o.name === "acme",
    )!.id;
    permissions = (
      await data.rolePermissions.list(CP, ownerRoleId, { per_page: 1000 })
    ).map((p) => p.permission_name);
    expect(permissions).toContain("create:roles");
  });

  for (const variant of ["org_name", "org_id"] as const) {
    it(`is refused on the control plane and on another tenant, and works on its own (${variant})`, async () => {
      const org =
        variant === "org_name" ? { org_name: "acme" } : { org_id: orgId };
      const claims = { sub: OWNER, permissions, ...org };

      // A write the owner scopes allow, aimed at the control plane or at
      // someone else's tenant.
      const assignRole = (tenantId: string) =>
        call(
          claims,
          tenantId,
          "POST",
          `/api/v2/users/${encodeURIComponent(OWNER)}/roles`,
          { roles: [ownerRoleId] },
        );
      const list = (tenantId: string) =>
        call(claims, tenantId, "GET", "/api/v2/users");

      expect((await assignRole(CP)).status).toBe(403);
      expect((await assignRole("globex")).status).toBe(403);
      expect((await list(CP)).status).toBe(403);
      expect((await list("globex")).status).toBe(403);
      expect((await list("acme")).status).toBe(200);
    });
  }
});
