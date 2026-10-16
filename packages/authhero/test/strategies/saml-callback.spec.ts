import { describe, it, expect, vi, beforeEach } from "vitest";
import { LogTypes } from "@authhero/adapter-interfaces";

const logMessage = vi.fn();
vi.mock("../../src/helpers/logging", () => ({
  logMessage: (...args: unknown[]) => logMessage(...args),
}));

const resolveSigningKeys = vi.fn();
vi.mock("../../src/helpers/signing-keys", () => ({
  resolveSigningKeys: (...args: unknown[]) => resolveSigningKeys(...args),
}));

vi.mock("@authhero/saml/core", () => ({
  createSamlResponse: vi.fn(async () => "BASE64_ASSERTION"),
  HttpSamlSigner: class {},
}));

import { samlCallback } from "../../src/strategies/saml";

const ctx: any = { env: { data: { keys: {} }, ISSUER: "https://issuer/" } };

function makeClient(overrides: Record<string, unknown> = {}): any {
  return {
    client_id: "saml-client",
    tenant: { id: "tenantId" },
    addons: {
      samlp: { recipient: "https://sp/acs", audience: "urn:sp" },
    },
    ...overrides,
  };
}

const authParams: any = {
  client_id: "saml-client",
  redirect_uri: "https://sp/acs",
  state: JSON.stringify({ requestId: "_req1", relayState: "rs" }),
};

const user: any = { user_id: "auth0|1", email: "a@example.com" };

beforeEach(() => {
  logMessage.mockClear();
  resolveSigningKeys.mockReset();
  resolveSigningKeys.mockResolvedValue([
    { kid: "kid1", cert: "CERT", pkcs7: "KEY" },
  ]);
});

describe("samlCallback logging", () => {
  it("logs assertion issuance without the assertion itself", async () => {
    const res = await samlCallback(
      ctx,
      makeClient(),
      authParams,
      user,
      "sid",
      "ls_1",
    );
    expect(res.status).toBe(200);

    expect(logMessage).toHaveBeenCalledTimes(1);
    const [, tenantId, params] = logMessage.mock.calls[0];
    expect(tenantId).toBe("tenantId");
    expect(params.type).toBe(LogTypes.INFORMATION);
    expect(params.login_session_id).toBe("ls_1");
    expect(params.details).toMatchObject({
      client_id: "saml-client",
      name_id: "auth0|1",
      name_id_source: "user_id",
      audience: "urn:sp",
      destination: "https://sp/acs",
      signing_key_kid: "kid1",
      in_response_to: "_req1",
    });
    expect(JSON.stringify(params)).not.toContain("BASE64_ASSERTION");
  });

  it("reports which NameID branch was used", async () => {
    await samlCallback(
      ctx,
      makeClient(),
      authParams,
      { ...user, app_metadata: { vimeo: { user_id: "v123" } } },
      "sid",
    );
    expect(logMessage.mock.calls[0][2].details).toMatchObject({
      name_id: "v123",
      name_id_source: "app_metadata.vimeo.user_id",
    });
  });

  const failures: Array<[string, () => Promise<unknown>, number, RegExp]> = [
    [
      "missing redirect_uri",
      () =>
        samlCallback(
          ctx,
          makeClient(),
          { ...authParams, redirect_uri: undefined },
          user,
          "sid",
        ),
      400,
      /Missing redirect_uri/,
    ],
    [
      "missing email",
      () =>
        samlCallback(
          ctx,
          makeClient(),
          authParams,
          { user_id: "x" } as any,
          "sid",
        ),
      400,
      /Missing email/,
    ],
    [
      "addon not enabled",
      () =>
        samlCallback(ctx, makeClient({ addons: {} }), authParams, user, "sid"),
      400,
      /SAML Addon is not enabled/,
    ],
    [
      "missing recipient",
      () =>
        samlCallback(
          ctx,
          makeClient({ addons: { samlp: {} } }),
          authParams,
          user,
          "sid",
        ),
      400,
      /Missing recipient or inResponseTo/,
    ],
  ];

  it.each(failures)(
    "logs a failed login on %s",
    async (_n, run, status, re) => {
      await expect(run()).rejects.toMatchObject({ status });
      expect(logMessage).toHaveBeenCalledTimes(1);
      const params = logMessage.mock.calls[0][2];
      expect(params.type).toBe(LogTypes.FAILED_LOGIN);
      expect(params.description).toMatch(re);
    },
  );

  it("logs a failed login when no signing key exists", async () => {
    resolveSigningKeys.mockResolvedValue([]);
    await expect(
      samlCallback(ctx, makeClient(), authParams, user, "sid"),
    ).rejects.toMatchObject({ status: 500 });
    expect(logMessage.mock.calls[0][2].type).toBe(LogTypes.FAILED_LOGIN);
    expect(logMessage.mock.calls[0][2].description).toMatch(
      /No signing key found/,
    );
  });

  it("logs and rethrows when the state is not valid JSON", async () => {
    await expect(
      samlCallback(
        ctx,
        makeClient(),
        { ...authParams, state: "not json" },
        user,
        "sid",
      ),
    ).rejects.toThrow();
    expect(logMessage.mock.calls[0][2].type).toBe(LogTypes.FAILED_LOGIN);
  });
});
