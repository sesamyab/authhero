import { describe, it, expect } from "vitest";
import { testClient } from "hono/testing";
import { getAdminToken } from "../../helpers/token";
import { getTestServer } from "../../helpers/test-server";

const baseTemplate = {
  template: "reset_email" as const,
  body: "<p>Reset {{ url }}</p>",
  from: "noreply@example.com",
  subject: "Reset your password",
  syntax: "liquid" as const,
  enabled: true,
  includeEmailInRedirect: false,
};

describe("emailTemplates", () => {
  it("GET returns 404 when no template is configured", async () => {
    const { managementApp, env } = await getTestServer();
    const client = testClient(managementApp, env);
    const token = await getAdminToken();

    const res = await client["email-templates"][":templateName"].$get(
      {
        header: { "tenant-id": "tenantId" },
        param: { templateName: "reset_email" },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(res.status).toBe(404);
  });

  it("POST creates a template (201) and 409 on duplicate", async () => {
    const { managementApp, env } = await getTestServer();
    const client = testClient(managementApp, env);
    const token = await getAdminToken();

    const created = await client["email-templates"].$post(
      {
        header: { "tenant-id": "tenantId" },
        json: baseTemplate,
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      template: "reset_email",
      subject: "Reset your password",
    });

    const dup = await client["email-templates"].$post(
      {
        header: { "tenant-id": "tenantId" },
        json: baseTemplate,
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(dup.status).toBe(409);
  });

  it("PUT upserts (creates if missing, replaces if present)", async () => {
    const { managementApp, env } = await getTestServer();
    const client = testClient(managementApp, env);
    const token = await getAdminToken();

    const upsert = await client["email-templates"][":templateName"].$put(
      {
        header: { "tenant-id": "tenantId" },
        param: { templateName: "verify_email" },
        json: { ...baseTemplate, template: "verify_email" },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(upsert.status).toBe(200);

    const replace = await client["email-templates"][":templateName"].$put(
      {
        header: { "tenant-id": "tenantId" },
        param: { templateName: "verify_email" },
        json: {
          ...baseTemplate,
          template: "verify_email",
          subject: "Updated",
        },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(replace.status).toBe(200);
    expect(await replace.json()).toMatchObject({ subject: "Updated" });
  });

  it("PATCH applies partial update; 404 if missing", async () => {
    const { managementApp, env } = await getTestServer();
    const client = testClient(managementApp, env);
    const token = await getAdminToken();

    const missing = await client["email-templates"][":templateName"].$patch(
      {
        header: { "tenant-id": "tenantId" },
        param: { templateName: "welcome_email" },
        json: { subject: "hi" },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(missing.status).toBe(404);

    await env.data.emailTemplates.create("tenantId", {
      ...baseTemplate,
      template: "welcome_email",
    });

    const patched = await client["email-templates"][":templateName"].$patch(
      {
        header: { "tenant-id": "tenantId" },
        param: { templateName: "welcome_email" },
        json: { subject: "Welcome aboard" },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({
      template: "welcome_email",
      subject: "Welcome aboard",
      body: baseTemplate.body,
    });
  });
});
