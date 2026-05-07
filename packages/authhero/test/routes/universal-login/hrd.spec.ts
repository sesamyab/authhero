import { describe, it, expect } from "vitest";
import { testClient } from "hono/testing";
import { getTestServer } from "../../helpers/test-server";
import {
  AuthorizationResponseType,
  Strategy,
} from "@authhero/adapter-interfaces";
import { USERNAME_PASSWORD_PROVIDER } from "../../../src/constants";

async function startAuthorizeFlow(oauthClient: any) {
  const authorizeResponse = await oauthClient.authorize.$get({
    query: {
      client_id: "clientId",
      redirect_uri: "https://example.com/callback",
      state: "state",
      nonce: "nonce",
      scope: "openid email profile",
      response_type: AuthorizationResponseType.CODE,
    },
  });
  expect(authorizeResponse.status).toBe(302);
  const location = authorizeResponse.headers.get("location");
  const universalUrl = new URL(`https://example.com${location}`);
  const state = universalUrl.searchParams.get("state");
  if (!state) throw new Error("No state found");
  return state;
}

describe("Home Realm Discovery (HRD)", () => {
  it("redirects to enterprise IdP when email domain matches domain_aliases", async () => {
    const { universalApp, oauthApp, env } = await getTestServer({
      mockEmail: true,
    });

    await env.data.connections.update("tenantId", "mock-strategy", {
      options: {
        client_id: "mockClientId",
        client_secret: "mockClientSecret",
        domain_aliases: ["acme.com"],
      },
    });

    const oauthClient = testClient(oauthApp, env);
    const universalClient = testClient(universalApp, env);
    const state = await startAuthorizeFlow(oauthClient);

    const response = await universalClient.login.identifier.$post({
      query: { state },
      form: { username: "alice@acme.com" },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://example.com/authorize",
    );
  });

  it("matches domain_aliases case-insensitively", async () => {
    const { universalApp, oauthApp, env } = await getTestServer({
      mockEmail: true,
    });

    await env.data.connections.update("tenantId", "mock-strategy", {
      options: {
        client_id: "mockClientId",
        client_secret: "mockClientSecret",
        domain_aliases: ["AcMe.CoM"],
      },
    });

    const oauthClient = testClient(oauthApp, env);
    const universalClient = testClient(universalApp, env);
    const state = await startAuthorizeFlow(oauthClient);

    const response = await universalClient.login.identifier.$post({
      query: { state },
      form: { username: "Alice@ACME.com" },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://example.com/authorize",
    );
  });

  it("falls through to OTP flow when no domain_aliases match", async () => {
    const { universalApp, oauthApp, env } = await getTestServer({
      mockEmail: true,
    });

    await env.data.connections.update("tenantId", "mock-strategy", {
      options: {
        client_id: "mockClientId",
        client_secret: "mockClientSecret",
        domain_aliases: ["acme.com"],
      },
    });

    const oauthClient = testClient(oauthApp, env);
    const universalClient = testClient(universalApp, env);
    const state = await startAuthorizeFlow(oauthClient);

    const response = await universalClient.login.identifier.$post({
      query: { state },
      form: { username: "bob@example.com" },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      "/u/login/email-otp-challenge",
    );
  });

  it("ignores domain_aliases on Username-Password connections", async () => {
    const { universalApp, oauthApp, env } = await getTestServer({
      mockEmail: true,
    });

    // Set domain_aliases on the Username-Password connection — HRD must NOT
    // route to it (it's not an enterprise/social IdP).
    await env.data.connections.update(
      "tenantId",
      "Username-Password-Authentication",
      {
        options: {
          domain_aliases: ["acme.com"],
        },
      },
    );

    const oauthClient = testClient(oauthApp, env);
    const universalClient = testClient(universalApp, env);
    const state = await startAuthorizeFlow(oauthClient);

    const response = await universalClient.login.identifier.$post({
      query: { state },
      form: { username: "alice@acme.com" },
    });

    expect(response.status).toBe(302);
    // Should fall through to OTP, not to the mock-strategy redirect URL.
    expect(response.headers.get("location")).not.toBe(
      "https://example.com/authorize",
    );
  });

  it("redirects via HRD even when an existing local-password user matches the email", async () => {
    const { universalApp, oauthApp, env } = await getTestServer({
      mockEmail: true,
    });

    await env.data.connections.update("tenantId", "mock-strategy", {
      options: {
        client_id: "mockClientId",
        client_secret: "mockClientSecret",
        domain_aliases: ["acme.com"],
      },
    });

    await env.data.users.create("tenantId", {
      user_id: `${USERNAME_PASSWORD_PROVIDER}|acmeuser`,
      email: "alice@acme.com",
      email_verified: true,
      provider: USERNAME_PASSWORD_PROVIDER,
      connection: Strategy.USERNAME_PASSWORD,
      is_social: false,
      app_metadata: { strategy: Strategy.USERNAME_PASSWORD },
    });

    const oauthClient = testClient(oauthApp, env);
    const universalClient = testClient(universalApp, env);
    const state = await startAuthorizeFlow(oauthClient);

    const response = await universalClient.login.identifier.$post({
      query: { state },
      form: { username: "alice@acme.com" },
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://example.com/authorize",
    );
  });
});
