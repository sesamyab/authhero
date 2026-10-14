import { describe, it, expect } from "vitest";
import { testClient } from "hono/testing";
import { getAdminToken } from "../../helpers/token";
import { getTestServer } from "../../helpers/test-server";
import {
  MAX_PROMPT_PARTIAL_LENGTH,
  sanitizePromptPartials,
} from "../../../src/helpers/prompt-partials";

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

  it("should reject disallowed markup and name what was found", async () => {
    const { managementApp, env } = await getTestServer();
    const managementClient = testClient(managementApp, env);
    const token = await getAdminToken();

    const put = (html: string) =>
      managementClient.prompts[":prompt"].partials.$put(
        {
          header: { "tenant-id": "tenantId" },
          param: { prompt: "login" },
          json: { login: { "form-content-end": html } },
        },
        { headers: { authorization: `Bearer ${token}` } },
      );

    for (const [html, expected] of [
      ["<iframe></iframe>", "<iframe>"],
      ['<a href="javascript:alert(2)">Link</a>', "href on <a>"],
      ['<iframe srcdoc="x"></iframe>', "<iframe>"],
      ['<object data="https://evil.example/x"></object>', "<object>"],
      ['<embed src="https://evil.example/x">', "<embed>"],
      ['<base href="https://evil.example/">', "<base>"],
      ['<meta http-equiv="refresh" content="0">', "<meta>"],
      ['<form action="https://evil.example/steal"></form>', "<form>"],
      ['<button formaction="https://evil.example/s">Go</button>', "formaction"],
      ['<svg><animate to="javascript:alert(3)"/></svg>', "<svg>"],
      ['<a href="//evil.example">Proto</a>', "href on <a>"],
      ['<img src="data:image/svg+xml,x" alt="x">', "src on <img>"],
    ] as const) {
      const response = await put(html);
      expect(response.status, html).toBe(400);
      const text = await response.text();
      expect(text, html).toContain("login.form-content-end");
      expect(text, html).toContain(expected);
    }

    const stored = await env.data.promptPartials?.get("tenantId", "login");
    expect(stored ?? {}).toEqual({});
  });

  describe("sanitizePromptPartials", () => {
    const sanitize = (html: string) =>
      sanitizePromptPartials({ login: { "form-content-end": html } }).login![
        "form-content-end"
      ];

    it("returns clean markup unchanged, including Liquid and void elements", () => {
      for (const html of [
        '<input name="x" data-authhero-map="user_metadata.x">',
        "<p>Hello {{ user.name }}</p>",
        '<input value="{{ user.email }}" placeholder="{% if a %}x{% endif %}">',
        "{% if a < b %}<p>less</p>{% endif %}",
        "{% if a > b %}<p>more</p>{% endif %}",
        '<select name="c">{% for c in countries %}<option value="{{ c.code }}">{{ c.name }}</option>{% endfor %}</select>',
        '<textarea name="t">hi</textarea>',
      ]) {
        expect(sanitize(html)).toBe(html);
      }
    });

    it("keeps option and textarea text", () => {
      const html =
        '<select name="c"><option value="se">Sweden</option></select><textarea name="t">hi</textarea>';
      expect(sanitize(html)).toBe(html);
    });

    it("rejects markup the sanitizer would remove", () => {
      for (const html of [
        "<noscript><p></noscript><img src=x onerror=alert(1)>",
        "<math><mi>x</mi></math>",
        '<a href="vbscript:x">v</a>',
        "<p <script>alert(1)</script>",
        '<select><option formaction="x">Sweden</option></select>',
      ]) {
        expect(() => sanitize(html), html).toThrow(/Disallowed markup/);
      }
    });

    it("drops comments instead of returning the original", () => {
      expect(sanitize("<p>a</p><!-- hidden -->")).toBe("<p>a</p>");
    });

    // Modeled on the custom-field examples in Auth0's prompt partials docs
    // (Liquid-driven select plus a terms checkbox), not a verbatim export.
    it("keeps a realistic Auth0-style partial intact", () => {
      const html = [
        '<div class="ulp-field ulp-field-select">',
        '  <label for="ulp-country">{{ "Country" | t }}</label>',
        '  <select id="ulp-country" name="ulp-country" required data-authhero-map="user_metadata.country" aria-required="true">',
        '    <option value="">Select a country</option>',
        "    {% for c in countries %}",
        '      <option value="{{ c.code }}">{{ c.name }}</option>',
        "    {% endfor %}",
        "  </select>",
        "</div>",
        '<div class="ulp-field">',
        '  <input type="checkbox" id="ulp-terms" name="ulp-terms" required>',
        '  <label for="ulp-terms">I accept the <a href="https://example.com/terms" target="_blank" rel="noopener noreferrer">terms</a></label>',
        "</div>",
      ].join("\n");
      expect(sanitize(html)).toBe(html);
    });

    // From Auth0's prompt partials docs: input, radio, select and textarea.
    it("keeps the Auth0 docs custom-field partial intact", () => {
      const html = `<div class="ulp-field">
  <label for="first-name">First Name</label>
  <input type="text" name="ulp-first-name" id="first-name">
  <div class="ulp-error-info"> First Name is Required </div>
</div><div class="ulp-field">
  <label>Select Account Type</label>
  <div>
    <input type="radio" name="ulp-account-type" id="acct-personal" value="personal">
    <label for="acct-personal">Personal Account</label>
  </div>
  <div>
    <input type="radio" name="ulp-account-type" id="acct-business" value="business">
    <label for="acct-business">Business Account</label>
  </div>
  <div class="ulp-error-info"> Please select an account type. </div>
</div><div class="ulp-field">
  <label for="preferred-language">Preferred Language</label>
  <select name="ulp-preferred-language" id="preferred-language">
    <option></option>
    <option value="english">English</option>
    <option value="french">French</option>
    <option value="spanish">Spanish</option>
  </select>
  <div class="ulp-error-info"> Please Select a Language. </div>
</div><div class="ulp-field">
  <label for="comments">Comments</label>
  <textarea type="text" name="ulp-comments" id="comments"></textarea>
  <div class="ulp-error-info">
    Please provide an answer.
  </div>
</div>
`;
      expect(sanitize(html)).toBe(html);
    });

    it("keeps scripts, styles and Liquid inside tags as Auth0 allows", () => {
      const html = [
        "<style>.ulp-field > input { color: red; }</style>",
        '<select name="c">',
        '  <option value="">Choose</option>',
        '  {% for c in countries %}<option value="{{ c.code }}" {% if c.code == user.country %}selected{% endif %}>{{ c.name }}</option>{% endfor %}',
        "</select>",
        '<input name="x" {% if required %}required{% endif %} placeholder="{{ "Name" | t }}">',
        "<script>",
        '  document.querySelectorAll("input").forEach((el) => { if (el.value.length < 3 && a > b) el.focus(); });',
        "</script>",
      ].join("\n");
      expect(sanitize(html)).toBe(html);
    });

    it("restores Liquid inside tags when other markup is rewritten", () => {
      const result = sanitize(
        '<p>a</p><!-- c --><input {% if r %}required{% endif %} name="x">',
      );
      expect(result).toContain("{% if r %}required{% endif %}");
      expect(result).not.toContain("data-liquid");
      expect(result).not.toContain("<!--");
    });

    it("keeps inline event handlers", () => {
      const html =
        '<button type="button" onclick="document.title = 1">Go</button>';
      expect(sanitize(html)).toBe(html);
    });

    it("adds rel to target=_blank links that lack or override it", () => {
      for (const attrs of ["", ' rel="nofollow"']) {
        expect(
          sanitize(`<a href="https://a.example" target="_blank"${attrs}>a</a>`),
        ).toBe(
          '<a href="https://a.example" target="_blank" rel="noopener noreferrer">a</a>',
        );
      }
    });

    it("forces rel on target=_blank links", () => {
      expect(
        sanitize('<a href="https://a.example" target="_blank">a</a>'),
      ).toBe(
        '<a href="https://a.example" target="_blank" rel="noopener noreferrer">a</a>',
      );
    });
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
