import { describe, it, expect } from "vitest";
import { testClient } from "hono/testing";
import { getAdminToken } from "../../helpers/token";
import { getTestServer } from "../../helpers/test-server";
import { MAX_PROMPT_PARTIAL_LENGTH } from "../../../src/helpers/prompt-partials";

describe("prompts", () => {
  it("should set and get prompts", async () => {
    const { managementApp, env } = await getTestServer();
    const managementClient = testClient(managementApp, env);

    const token = await getAdminToken();
    const defaultPromptsSettingsResponse = await managementClient.prompts.$get(
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
    expect(defaultPromptsSettingsResponse.status).toBe(200);
    const defalutPromptSetting = await defaultPromptsSettingsResponse.json();

    expect(defalutPromptSetting).toEqual({
      identifier_first: false,
      password_first: false,
      show_last_used_connection: false,
      universal_login_experience: "new",
      webauthn_platform_first_factor: false,
    });

    // Update the branding
    const updateBrandingResponse = await managementClient.prompts.$patch(
      {
        header: {
          "tenant-id": "tenantId",
        },
        json: {
          identifier_first: false,
          password_first: false,
        },
      },
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
    );

    expect(updateBrandingResponse.status).toBe(200);
    const updateBrandingResponseBody = await updateBrandingResponse.json();
    expect(updateBrandingResponseBody).toEqual({
      identifier_first: false,
      password_first: false,
      show_last_used_connection: false,
      universal_login_experience: "new",
      webauthn_platform_first_factor: false,
    });
  });

  it("should set, get, list, and delete custom text", async () => {
    const { managementApp, env } = await getTestServer();
    const managementClient = testClient(managementApp, env);
    const token = await getAdminToken();

    // ----------------------------------------
    // Get non-existent custom text returns an empty object — terraform's
    // auth0 provider PUTs desired state then GETs to confirm; returning
    // defaults here breaks PUT/GET symmetry and hangs the provider.
    // ----------------------------------------
    const emptyResponse = await managementClient.prompts[":prompt"][
      "custom-text"
    ][":language"].$get(
      {
        header: { "tenant-id": "tenantId" },
        param: { prompt: "login", language: "en" },
      },
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(emptyResponse.status).toBe(200);
    expect(await emptyResponse.json()).toEqual({});

    // ----------------------------------------
    // Set custom text
    // ----------------------------------------
    const setResponse = await managementClient.prompts[":prompt"][
      "custom-text"
    ][":language"].$put(
      {
        header: { "tenant-id": "tenantId" },
        param: { prompt: "login", language: "en" },
        json: {
          login: {
            pageTitle: "Welcome Back",
            buttonText: "Sign In",
            description: "Please enter your credentials",
          },
        },
      },
      {
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
      },
    );
    expect(setResponse.status).toBe(200);
    expect(await setResponse.json()).toEqual({
      login: {
        pageTitle: "Welcome Back",
        buttonText: "Sign In",
        description: "Please enter your credentials",
      },
    });

    // ----------------------------------------
    // Get custom text
    // ----------------------------------------
    const getResponse = await managementClient.prompts[":prompt"][
      "custom-text"
    ][":language"].$get(
      {
        header: { "tenant-id": "tenantId" },
        param: { prompt: "login", language: "en" },
      },
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(getResponse.status).toBe(200);
    expect(await getResponse.json()).toEqual({
      login: {
        pageTitle: "Welcome Back",
        buttonText: "Sign In",
        description: "Please enter your credentials",
      },
    });

    // ----------------------------------------
    // Set custom text for another language
    // ----------------------------------------
    await managementClient.prompts[":prompt"]["custom-text"][":language"].$put(
      {
        header: { "tenant-id": "tenantId" },
        param: { prompt: "login", language: "de" },
        json: {
          login: {
            pageTitle: "Willkommen zurück",
            buttonText: "Anmelden",
          },
        },
      },
      {
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
      },
    );

    // ----------------------------------------
    // Set custom text for another prompt
    // ----------------------------------------
    await managementClient.prompts[":prompt"]["custom-text"][":language"].$put(
      {
        header: { "tenant-id": "tenantId" },
        param: { prompt: "signup", language: "en" },
        json: {
          signup: {
            pageTitle: "Create Account",
            buttonText: "Sign Up",
          },
        },
      },
      {
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
      },
    );

    // ----------------------------------------
    // List all custom text entries
    // ----------------------------------------
    const listResponse = await managementClient.prompts["custom-text"].$get(
      {
        header: { "tenant-id": "tenantId" },
      },
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(listResponse.status).toBe(200);
    const entries = await listResponse.json();
    expect(entries).toHaveLength(3);
    expect(entries).toContainEqual({ prompt: "login", language: "en" });
    expect(entries).toContainEqual({ prompt: "login", language: "de" });
    expect(entries).toContainEqual({ prompt: "signup", language: "en" });

    // ----------------------------------------
    // Delete custom text
    // ----------------------------------------
    const deleteResponse = await managementClient.prompts[":prompt"][
      "custom-text"
    ][":language"].$delete(
      {
        header: { "tenant-id": "tenantId" },
        param: { prompt: "login", language: "de" },
      },
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(deleteResponse.status).toBe(204);

    // Verify deletion
    const afterDeleteResponse = await managementClient.prompts[":prompt"][
      "custom-text"
    ][":language"].$get(
      {
        header: { "tenant-id": "tenantId" },
        param: { prompt: "login", language: "de" },
      },
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    // After deletion, GET returns an empty object (no defaults merge).
    expect(await afterDeleteResponse.json()).toEqual({});

    // Verify list is updated
    const listAfterDeleteResponse = await managementClient.prompts[
      "custom-text"
    ].$get(
      {
        header: { "tenant-id": "tenantId" },
      },
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    const entriesAfterDelete = await listAfterDeleteResponse.json();
    expect(entriesAfterDelete).toHaveLength(2);
  });

  it("should list bundled custom-text defaults with filters", async () => {
    const { managementApp, env } = await getTestServer();
    const managementClient = testClient(managementApp, env);
    const token = await getAdminToken();

    const allResponse = await managementClient.prompts["custom-text"][
      "defaults"
    ].$get(
      {
        header: { "tenant-id": "tenantId" },
        query: {},
      },
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(allResponse.status).toBe(200);
    const allEntries = await allResponse.json();
    expect(allEntries.length).toBeGreaterThan(0);
    const distinctLanguages = new Set(allEntries.map((e) => e.language));
    expect(distinctLanguages.size).toBeGreaterThan(1);

    const enLoginResponse = await managementClient.prompts["custom-text"][
      "defaults"
    ].$get(
      {
        header: { "tenant-id": "tenantId" },
        query: { language: "en", prompt: "login" },
      },
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(enLoginResponse.status).toBe(200);
    const enLogin = await enLoginResponse.json();
    expect(enLogin).toHaveLength(1);
    expect(enLogin[0]?.prompt).toBe("login");
    expect(enLogin[0]?.language).toBe("en");
    expect(Object.keys(enLogin[0]?.custom_text ?? {}).length).toBeGreaterThan(
      0,
    );
  });

  it("should validate prompt screen type", async () => {
    const { managementApp, env } = await getTestServer();
    const managementClient = testClient(managementApp, env);
    const token = await getAdminToken();

    // Try to get custom text with invalid prompt type
    const response = await managementClient.prompts[":prompt"]["custom-text"][
      ":language"
    ].$get(
      {
        header: { "tenant-id": "tenantId" },
        param: { prompt: "invalid-prompt" as any, language: "en" },
      },
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
    expect(response.status).toBe(400);
  });

  it("should round-trip prompt partials and replace the whole object", async () => {
    const { managementApp, env } = await getTestServer();
    const managementClient = testClient(managementApp, env);
    const token = await getAdminToken();

    const emptyResponse = await managementClient.prompts[
      ":prompt"
    ].partials.$get(
      {
        header: { "tenant-id": "tenantId" },
        param: { prompt: "signup" },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(emptyResponse.status).toBe(200);
    expect(await emptyResponse.json()).toEqual({});

    const partials = {
      signup: {
        "form-content-start": "<p>Tell us about yourself</p>",
        "form-content-end":
          '<input name="ulp-first-name" data-authhero-map="given_name" required>',
      },
    };
    const putResponse = await managementClient.prompts[":prompt"].partials.$put(
      {
        header: { "tenant-id": "tenantId" },
        param: { prompt: "signup" },
        json: partials,
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(putResponse.status).toBe(200);
    expect(await putResponse.json()).toEqual(partials);

    const getResponse = await managementClient.prompts[":prompt"].partials.$get(
      {
        header: { "tenant-id": "tenantId" },
        param: { prompt: "signup" },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(await getResponse.json()).toEqual(partials);

    const replaceResponse = await managementClient.prompts[
      ":prompt"
    ].partials.$put(
      {
        header: { "tenant-id": "tenantId" },
        param: { prompt: "signup" },
        json: {},
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(replaceResponse.status).toBe(200);
    expect(await replaceResponse.json()).toEqual({});

    const afterReplace = await managementClient.prompts[
      ":prompt"
    ].partials.$get(
      {
        header: { "tenant-id": "tenantId" },
        param: { prompt: "signup" },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(await afterReplace.json()).toEqual({});
  });

  it("should sanitize unsafe prompt partial markup before storing it", async () => {
    const { managementApp, env } = await getTestServer();
    const managementClient = testClient(managementApp, env);
    const token = await getAdminToken();

    const response = await managementClient.prompts[":prompt"].partials.$put(
      {
        header: { "tenant-id": "tenantId" },
        param: { prompt: "signup" },
        json: {
          signup: {
            "form-content-end":
              '<script>alert(1)</script><a href="javascript:alert(2)" onclick="alert(3)">Link</a><input name="ulp-company" data-authhero-map="user_metadata.company">',
          },
        },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    const html = body.signup?.["form-content-end"] ?? "";
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("onclick");
    expect(html).toContain('data-authhero-map="user_metadata.company"');

    const stored = await env.data.promptPartials?.get("tenantId", "signup");
    expect(stored).toEqual(body);
  });

  it("should require the matching prompt scope for each partials operation", async () => {
    const { managementApp, env } = await getTestServer();
    const managementClient = testClient(managementApp, env);
    const readToken = await getAdminToken({ permissions: ["read:prompts"] });
    const updateToken = await getAdminToken({
      permissions: ["update:prompts"],
    });
    const request = {
      header: { "tenant-id": "tenantId" },
      param: { prompt: "signup" as const },
    };

    const allowedRead = await managementClient.prompts[":prompt"].partials.$get(
      request,
      { headers: { authorization: `Bearer ${readToken}` } },
    );
    expect(allowedRead.status).toBe(200);

    const deniedRead = await managementClient.prompts[":prompt"].partials.$get(
      request,
      { headers: { authorization: `Bearer ${updateToken}` } },
    );
    expect(deniedRead.status).toBe(403);

    const allowedUpdate = await managementClient.prompts[
      ":prompt"
    ].partials.$put(
      { ...request, json: {} },
      { headers: { authorization: `Bearer ${updateToken}` } },
    );
    expect(allowedUpdate.status).toBe(200);

    const deniedUpdate = await managementClient.prompts[
      ":prompt"
    ].partials.$put(
      { ...request, json: {} },
      { headers: { authorization: `Bearer ${readToken}` } },
    );
    expect(deniedUpdate.status).toBe(403);
  });

  it("should reject invalid prompts, insertion points, mapping targets, and oversized partials", async () => {
    const { managementApp, env } = await getTestServer();
    const managementClient = testClient(managementApp, env);
    const token = await getAdminToken();
    const requestOptions = {
      headers: { authorization: `Bearer ${token}` },
    };

    const invalidPrompt = await managementClient.prompts[
      ":prompt"
    ].partials.$put(
      {
        header: { "tenant-id": "tenantId" },
        param: { prompt: "logout" as any },
        json: {},
      },
      requestOptions,
    );
    expect(invalidPrompt.status).toBe(400);

    const invalidInsertionPoint = await managementClient.prompts[
      ":prompt"
    ].partials.$put(
      {
        header: { "tenant-id": "tenantId" },
        param: { prompt: "signup" },
        json: {
          signup: {
            "not-an-insertion-point": "<p>No</p>",
          } as any,
        },
      },
      requestOptions,
    );
    expect(invalidInsertionPoint.status).toBe(400);

    const invalidMapping = await managementClient.prompts[
      ":prompt"
    ].partials.$put(
      {
        header: { "tenant-id": "tenantId" },
        param: { prompt: "signup" },
        json: {
          signup: {
            "form-content-end":
              '<input name="ulp-email" data-authhero-map="email">',
          },
        },
      },
      requestOptions,
    );
    expect(invalidMapping.status).toBe(400);
    expect(await invalidMapping.json()).toMatchObject({
      message: expect.stringContaining(
        'Invalid data-authhero-map target "email"',
      ),
    });

    const oversized = await managementClient.prompts[":prompt"].partials.$put(
      {
        header: { "tenant-id": "tenantId" },
        param: { prompt: "signup" },
        json: {
          signup: {
            "form-content-end": "x".repeat(MAX_PROMPT_PARTIAL_LENGTH + 1),
          },
        },
      },
      requestOptions,
    );
    expect(oversized.status).toBe(400);
    expect(await oversized.json()).toMatchObject({
      message: expect.stringContaining("character limit"),
    });
  });
});
