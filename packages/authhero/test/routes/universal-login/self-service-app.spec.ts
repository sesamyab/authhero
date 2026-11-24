import { describe, it, expect } from "vitest";
import { getTestServer } from "../../helpers/test-server";
import { getAdminToken } from "../../helpers/token";
import type { Bindings } from "../../../src/types";

/**
 * The developer app setup page (#1776) at /u2/self-service/app: invite links
 * register an app, edit links update one, and every request re-checks the
 * link.
 */

async function management(
  managementApp: any,
  env: Bindings,
  path: string,
  body?: unknown,
) {
  const token = await getAdminToken();
  return managementApp.request(
    path,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "tenant-id": "tenantId",
        "content-type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
    },
    env,
  );
}

async function invite(
  managementApp: any,
  env: Bindings,
  preset: "native" | "spa" | "regular_web",
) {
  const response = await management(
    managementApp,
    env,
    "/client-registration-tokens",
    { preset, name: "Agency" },
  );
  expect(response.status).toBe(201);
  const body = await response.json();
  return {
    id: body.id as string,
    ticket: new URL(body.ticket).searchParams.get("ticket")!,
  };
}

async function open(
  u2App: any,
  env: Bindings,
  ticket: string,
  tenant = "tenantId",
) {
  return u2App.request(
    `/self-service/app?ticket=${encodeURIComponent(ticket)}`,
    { headers: { "tenant-id": tenant } },
    env,
  );
}

async function openSession(u2App: any, env: Bindings, ticket: string) {
  const landing = await open(u2App, env, ticket);
  expect(landing.status).toBe(302);
  const location = landing.headers.get("location")!;
  expect(location).not.toContain(ticket);
  return new URL(location, "http://localhost").searchParams.get("state")!;
}

async function getPage(u2App: any, env: Bindings, state: string) {
  return u2App.request(
    `/self-service/app?state=${encodeURIComponent(state)}`,
    { headers: { "tenant-id": "tenantId" } },
    env,
  );
}

async function submit(
  u2App: any,
  env: Bindings,
  state: string,
  fields: Record<string, string>,
) {
  return u2App.request(
    `/self-service/app?state=${encodeURIComponent(state)}`,
    {
      method: "POST",
      headers: {
        "tenant-id": "tenantId",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields).toString(),
    },
    env,
  );
}

describe("developer app setup page: invite links", () => {
  it("shows one generic page for an unknown link", async () => {
    const { u2App, env } = await getTestServer();
    const response = await open(u2App, env, "not-a-real-ticket");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("This link can&#39;t be used");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("registers a native app and shows its client ID without a secret", async () => {
    const { managementApp, u2App, env } = await getTestServer();
    const { id, ticket } = await invite(managementApp, env, "native");

    const landing = await open(u2App, env, ticket);
    expect(landing.status).toBe(302);
    expect(landing.headers.get("referrer-policy")).toBe("no-referrer");
    const state = new URL(
      landing.headers.get("location")!,
      "http://localhost",
    ).searchParams.get("state")!;

    const page = await getPage(u2App, env, state);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Register your app");
    expect(html).toContain("Native app");

    const done = await submit(u2App, env, state, {
      client_name: "Publisher iOS",
      redirect_uris: "com.example.app:/callback\nhttp://127.0.0.1:7777/cb",
      post_logout_redirect_uris: "",
      logo_uri: "",
      client_uri: "",
      policy_uri: "",
      tos_uri: "",
      contact: "dev@example.com",
    });
    expect(done.status).toBe(200);
    const doneHtml = await done.text();
    expect(doneHtml).toContain("Your app is registered");

    const token = await env.data.clientRegistrationTokens!.get("tenantId", id);
    expect(token?.used_at).toBeTruthy();
    const client = await env.data.clients.get("tenantId", token!.client_id!);
    expect(client?.name).toBe("Publisher iOS");
    expect(client?.app_type).toBe("native");
    expect(client?.callbacks).toEqual([
      "com.example.app:/callback",
      "http://127.0.0.1:7777/cb",
    ]);
    expect(client?.client_secret).toBeFalsy();
    expect(client?.client_metadata?.contacts).toBe("dev@example.com");
    expect(doneHtml).toContain(client!.client_id);
    expect(doneHtml).not.toContain("Client secret");

    // The page shows the result again, the link itself is used up.
    const again = await getPage(u2App, env, state);
    expect(await again.text()).toContain("Your app is registered");
    expect((await open(u2App, env, ticket)).status).toBe(400);
    const resubmit = await submit(u2App, env, state, {
      client_name: "Second",
      redirect_uris: "com.example.app:/callback",
    });
    expect(await resubmit.text()).toContain("This link can");
  });

  it("shows the client secret once for a regular web app", async () => {
    const { managementApp, u2App, env } = await getTestServer();
    const { id, ticket } = await invite(managementApp, env, "regular_web");
    const state = await openSession(u2App, env, ticket);

    const done = await submit(u2App, env, state, {
      client_name: "Web",
      redirect_uris: "https://app.example.com/callback",
      web_origins: "https://app.example.com",
    });
    const html = await done.text();
    expect(html).toContain("Client secret");
    const token = await env.data.clientRegistrationTokens!.get("tenantId", id);
    const client = await env.data.clients.get("tenantId", token!.client_id!);
    expect(html).toContain(client!.client_secret!);
    expect(client?.web_origins).toEqual(["https://app.example.com"]);

    const reload = await getPage(u2App, env, state);
    expect(await reload.text()).not.toContain(client!.client_secret!);
  });

  it("shows field errors and keeps the values entered", async () => {
    const { managementApp, u2App, env } = await getTestServer();
    const { id, ticket } = await invite(managementApp, env, "spa");
    const state = await openSession(u2App, env, ticket);

    const response = await submit(u2App, env, state, {
      client_name: "SPA",
      redirect_uris: "http://app.example.com/callback",
    });
    expect(response.status).toBe(400);
    const html = await response.text();
    expect(html).toContain("use https");
    expect(html).toContain("http://app.example.com/callback");

    const missing = await submit(u2App, env, state, {
      client_name: "",
      redirect_uris: "",
    });
    expect(await missing.text()).toContain("This field is required.");

    const token = await env.data.clientRegistrationTokens!.get("tenantId", id);
    expect(token?.used_at).toBeFalsy();
  });

  it("stops working when the invite is revoked during the session", async () => {
    const { managementApp, u2App, env } = await getTestServer();
    const { id, ticket } = await invite(managementApp, env, "spa");
    const state = await openSession(u2App, env, ticket);

    const revoke = await management(
      managementApp,
      env,
      `/client-registration-tokens/${id}/revoke`,
    );
    expect(revoke.status).toBe(202);

    const response = await submit(u2App, env, state, {
      client_name: "SPA",
      redirect_uris: "https://app.example.com/callback",
    });
    expect(await response.text()).toContain("This link can");
    const token = await env.data.clientRegistrationTokens!.get("tenantId", id);
    expect(token?.used_at).toBeFalsy();
  });

  it("does not accept a link on another tenant", async () => {
    const { managementApp, u2App, env } = await getTestServer();
    await env.data.tenants.create({
      id: "otherTenant",
      friendly_name: "Other",
      audience: "https://other.example.com",
      sender_email: "login@example.com",
      sender_name: "Other",
    });
    const { ticket } = await invite(managementApp, env, "spa");
    expect((await open(u2App, env, ticket, "otherTenant")).status).toBe(400);
  });

  it("does not open plain Initial Access Tokens minted without a preset", async () => {
    const { managementApp, u2App, env } = await getTestServer();
    const response = await management(
      managementApp,
      env,
      "/client-registration-tokens",
      { expires_in_seconds: 600 },
    );
    const { token } = await response.json();
    expect((await open(u2App, env, token)).status).toBe(400);
  });
});

describe("developer app setup page: widget JSON contract", () => {
  async function submitThroughWidget(
    u2App: any,
    env: Bindings,
    state: string,
    data: Record<string, string>,
  ) {
    const page = await getPage(u2App, env, state);
    const html = await page.text();
    const match = html.match(
      /<script type="application\/json" data-authhero="screen">([\s\S]*?)<\/script>/,
    );
    expect(match).toBeTruthy();
    const screen = JSON.parse(match![1]!);
    expect(screen.action).toContain("/u2/screen/self-service-app");
    return u2App.request(
      screen.action.replace(/^\/u2/, ""),
      {
        method: "POST",
        headers: {
          "tenant-id": "tenantId",
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ data }),
      },
      env,
    );
  }

  it("registers the app and returns the done screen as JSON", async () => {
    const { managementApp, u2App, env } = await getTestServer();
    const { id, ticket } = await invite(managementApp, env, "spa");
    const state = await openSession(u2App, env, ticket);

    const invalid = await submitThroughWidget(u2App, env, state, {
      client_name: "SPA",
      redirect_uris: "https://*.example.com/cb",
    });
    const invalidBody = JSON.stringify(await invalid.json());
    expect(invalidBody).toContain("wildcards are not allowed");

    const response = await submitThroughWidget(u2App, env, state, {
      client_name: "SPA",
      redirect_uris: "https://app.example.com/callback",
      web_origins: "https://app.example.com",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body.screen.name).toBe("self-service-app-done");

    const token = await env.data.clientRegistrationTokens!.get("tenantId", id);
    expect(token?.client_id).toBeTruthy();
    expect(JSON.stringify(body)).toContain(token!.client_id!);
  });
});

describe("developer app setup page: edit links", () => {
  async function editLink(managementApp: any, env: Bindings) {
    const response = await management(
      managementApp,
      env,
      "/clients/clientId/registration-ticket",
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    return new URL(body.ticket).searchParams.get("ticket")!;
  }

  it("pre-fills the app and saves allowed changes only", async () => {
    const { managementApp, u2App, env } = await getTestServer();
    const ticket = await editLink(managementApp, env);
    const state = await openSession(u2App, env, ticket);

    const page = await getPage(u2App, env, state);
    const html = await page.text();
    expect(html).toContain("Update Test Client");
    expect(html).toContain("https://example.com/callback");

    const before = await env.data.clients.get("tenantId", "clientId");
    const saved = await submit(u2App, env, state, {
      client_name: "Test Client",
      // The existing wildcard entry is kept as it was.
      redirect_uris:
        "https://example.com/callback\nhttp://localhost:3000/*\nhttps://beta.example.com/callback",
      post_logout_redirect_uris: "https://example.com/callback",
      web_origins: "https://example.com",
    });
    expect(saved.status).toBe(200);
    expect(await saved.text()).toContain("Changes saved.");

    const after = await env.data.clients.get("tenantId", "clientId");
    expect(after?.callbacks).toContain("https://beta.example.com/callback");
    expect(after?.grant_types).toEqual(before?.grant_types);
    expect(after?.token_endpoint_auth_method).toBe(
      before?.token_endpoint_auth_method,
    );
    expect(after?.client_secret).toBe(before?.client_secret);

    // An edit link stays usable until it expires or is revoked.
    const again = await submit(u2App, env, state, {
      client_name: "Renamed",
      redirect_uris: "https://example.com/callback",
    });
    expect(again.status).toBe(200);
    expect((await env.data.clients.get("tenantId", "clientId"))?.name).toBe(
      "Renamed",
    );
  });

  it("stops working once a newer edit link replaces it", async () => {
    const { managementApp, u2App, env } = await getTestServer();
    const first = await editLink(managementApp, env);
    const state = await openSession(u2App, env, first);
    await editLink(managementApp, env);

    const response = await getPage(u2App, env, state);
    expect(await response.text()).toContain("This link can");
    expect((await open(u2App, env, first)).status).toBe(400);
  });
});
