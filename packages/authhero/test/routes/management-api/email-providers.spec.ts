import { describe, it, expect } from "vitest";
import { testClient } from "hono/testing";
import { getAdminToken } from "../../helpers/token";
import { getTestServer } from "../../helpers/test-server";

describe("emailProviders", () => {
  it("should set and get a email provider", async () => {
    const { managementApp, env } = await getTestServer();
    const managementClient = testClient(managementApp, env);

    const token = await getAdminToken();

    // Delete the default email provider created by test setup
    await env.data.emailProviders.remove("tenantId");

    // Auth0 returns 200 with an empty object when no provider is configured.
    const emptyEmailProviderResponse =
      await managementClient.email.providers.$get(
        {
          header: {
            "tenant-id": "tenantId",
          },
        },
        {
          headers: {
            authorization: `Bearer ${token}`,
          },
        },
      );
    expect(emptyEmailProviderResponse.status).toBe(200);
    expect(await emptyEmailProviderResponse.json()).toEqual({});

    // Set the email provider
    const createEmailProviderResponse =
      await managementClient.email.providers.$post(
        {
          header: {
            "tenant-id": "tenantId",
          },
          json: {
            name: "sendgrid",
            credentials: {
              api_key: "apiKey",
            },
          },
        },
        {
          headers: {
            authorization: `Bearer ${token}`,
          },
        },
      );

    expect(createEmailProviderResponse.status).toBe(201);

    // Update the provider
    const updateEmailProviderResponse =
      await managementClient.email.providers.$patch(
        {
          header: {
            "tenant-id": "tenantId",
          },
          json: {
            name: "mailgun",
          },
        },
        {
          headers: {
            authorization: `Bearer ${token}`,
          },
        },
      );

    expect(updateEmailProviderResponse.status).toBe(200);

    // Get the email provider
    const emailProviderResponse = await managementClient.email.providers.$get(
      {
        header: {
          "tenant-id": "tenantId",
        },
      },
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    );

    expect(emailProviderResponse.status).toBe(200);
    const emailProvider = await emailProviderResponse.json();

    expect(emailProvider).toMatchObject({
      name: "mailgun",
      enabled: true,
      credentials: {
        api_key: "apiKey",
      },
    });
  });

  it("returns 409 on POST when a provider is already configured", async () => {
    const { managementApp, env } = await getTestServer();
    const managementClient = testClient(managementApp, env);
    const token = await getAdminToken();

    await env.data.emailProviders.remove("tenantId");

    const first = await managementClient.email.providers.$post(
      {
        header: { "tenant-id": "tenantId" },
        json: {
          name: "sendgrid",
          credentials: { api_key: "apiKey" },
        },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(first.status).toBe(201);

    const second = await managementClient.email.providers.$post(
      {
        header: { "tenant-id": "tenantId" },
        json: {
          name: "mailgun",
          credentials: { api_key: "apiKey", domain: "mg.example.com" },
        },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(second.status).toBe(409);
  });

  it("returns 404 on PATCH when no provider is configured", async () => {
    const { managementApp, env } = await getTestServer();
    const managementClient = testClient(managementApp, env);
    const token = await getAdminToken();

    await env.data.emailProviders.remove("tenantId");

    const res = await managementClient.email.providers.$patch(
      {
        header: { "tenant-id": "tenantId" },
        json: { name: "mailgun" },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(404);
  });

  it("DELETE removes the provider and returns 204; subsequent GET is 200 with empty body", async () => {
    const { managementApp, env } = await getTestServer();
    const managementClient = testClient(managementApp, env);
    const token = await getAdminToken();

    // Default provider is seeded by the test server, so DELETE should succeed.
    const deleted = await managementClient.email.providers.$delete(
      { header: { "tenant-id": "tenantId" } },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(deleted.status).toBe(204);

    const get = await managementClient.email.providers.$get(
      { header: { "tenant-id": "tenantId" } },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({});
  });

  it("DELETE returns 404 when no provider is configured", async () => {
    const { managementApp, env } = await getTestServer();
    const managementClient = testClient(managementApp, env);
    const token = await getAdminToken();

    await env.data.emailProviders.remove("tenantId");

    const res = await managementClient.email.providers.$delete(
      { header: { "tenant-id": "tenantId" } },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(404);
  });
});
