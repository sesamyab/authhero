import { describe, it, expect } from "vitest";
import { getTestServer } from "../helpers/test-server";
import {
  HookEvent,
  OnExecutePreUserRegistrationAPI,
} from "../../src/types/Hooks";
import { testClient } from "hono/testing";
import { getAdminToken } from "../helpers/token";
import { UserResponse, Strategy } from "@authhero/adapter-interfaces";
import { LocalCodeExecutor } from "../../src/hooks/code-executor/local";

describe("on-pre-user-registration-hook", () => {
  it("should link user to primary via setLinkedTo", async () => {
    let primaryUserId: string | undefined;
    const events: HookEvent[] = [];

    const { env, managementApp } = await getTestServer({
      hooks: {
        onExecutePreUserRegistration: async (
          event: HookEvent,
          api: OnExecutePreUserRegistrationAPI,
        ) => {
          events.push(event);
          // Link to the primary user when creating a new user
          if (primaryUserId) {
            api.user.setLinkedTo(primaryUserId);
          }
        },
      },
    });

    const client = testClient(managementApp, env);
    const token = await getAdminToken();

    // Create a primary user first
    const primaryResponse = await client.users.$post(
      {
        json: {
          email: "primary@example.com",
          connection: Strategy.USERNAME_PASSWORD,
        },
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

    expect(primaryResponse.status).toBe(201);
    const primaryUser = (await primaryResponse.json()) as UserResponse;
    primaryUserId = primaryUser.user_id;

    // The event should carry the tenant, matching update/deletion hooks
    expect(events[0]?.tenant).toEqual({ id: "tenantId" });
    expect(events[0]?.request.body).toBeUndefined();

    // Create a secondary user that will be linked to the primary
    const secondaryResponse = await client.users.$post(
      {
        json: {
          email: "secondary@example.com",
          connection: "google-oauth2",
        },
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

    expect(secondaryResponse.status).toBe(201);
    // The returned user should be the primary user with the new identity linked
    const returnedUser = (await secondaryResponse.json()) as UserResponse;
    expect(returnedUser.user_id).toBe(primaryUserId);
    expect(returnedUser.identities).toHaveLength(2);
  });

  it("keeps the legacy top-level setUserMetadata behavior by default", async () => {
    const { env, managementApp } = await getTestServer({
      hooks: {
        onExecutePreUserRegistration: async (
          _: HookEvent,
          api: OnExecutePreUserRegistrationAPI,
        ) => {
          api.user.setUserMetadata("given_name", "given_name");
        },
      },
    });

    const client = testClient(managementApp, env);

    const token = await getAdminToken();

    // Create a user
    const userResponse = await client.users.$post(
      {
        json: {
          email: "foo2@example.com",
          connection: Strategy.USERNAME_PASSWORD,
        },
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

    expect(userResponse.status).toBe(201);
    const user = await userResponse.json();

    expect(user?.given_name).toBe("given_name");
  });

  it("merges user and app metadata when Auth0-compatible behavior is enabled", async () => {
    const { env, managementApp } = await getTestServer({
      hooks: {
        onExecutePreUserRegistration: async (_event, api) => {
          api.user.setUserMetadata("first_name", "Ada");
          api.user.setAppMetadata("plan", "pro");
        },
      },
    });
    await env.data.tenants.update("tenantId", {
      flags: { enable_auth0_pre_user_registration_metadata: true },
    });

    const client = testClient(managementApp, env);
    const token = await getAdminToken();
    const response = await client.users.$post(
      {
        json: {
          email: "metadata@example.com",
          connection: Strategy.USERNAME_PASSWORD,
          user_metadata: { existing_user_key: "preserved" },
          app_metadata: { existing_app_key: "preserved" },
        },
        header: { "tenant-id": "tenantId" },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(201);
    const user = (await response.json()) as UserResponse &
      Record<string, unknown>;
    expect(user.user_metadata).toEqual({
      existing_user_key: "preserved",
      first_name: "Ada",
    });
    expect(user.app_metadata).toEqual({
      existing_app_key: "preserved",
      plan: "pro",
    });
    expect(user).not.toHaveProperty("first_name");
    expect(user).not.toHaveProperty("plan");
  });

  it("exposes Auth0-compatible metadata setters to code hooks", async () => {
    const { env, managementApp } = await getTestServer({
      codeExecutor: new LocalCodeExecutor(),
    });
    await env.data.tenants.update("tenantId", {
      flags: { enable_auth0_pre_user_registration_metadata: true },
    });
    const action = await env.data.actions.create("tenantId", {
      name: "set-signup-metadata",
      code: `
exports.onExecutePreUserRegistration = async (_event, api) => {
  api.user.setUserMetadata("first_name", "Ada");
  api.user.setAppMetadata("plan", "pro");
};
`,
    });
    await env.data.hooks.create("tenantId", {
      trigger_id: "pre-user-registration",
      enabled: true,
      code_id: action.id,
      synchronous: true,
    });

    const client = testClient(managementApp, env);
    const token = await getAdminToken();
    const response = await client.users.$post(
      {
        json: {
          email: "code-metadata@example.com",
          connection: Strategy.USERNAME_PASSWORD,
          user_metadata: { existing_user_key: "preserved" },
          app_metadata: { existing_app_key: "preserved" },
        },
        header: { "tenant-id": "tenantId" },
      },
      { headers: { authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(201);
    const user = (await response.json()) as UserResponse &
      Record<string, unknown>;
    expect(user.user_metadata).toEqual({
      existing_user_key: "preserved",
      first_name: "Ada",
    });
    expect(user.app_metadata).toEqual({
      existing_app_key: "preserved",
      plan: "pro",
    });
    expect(user).not.toHaveProperty("first_name");
    expect(user).not.toHaveProperty("plan");
  });

  it("should block user creation when deny() is called", async () => {
    const { env, managementApp } = await getTestServer({
      hooks: {
        onExecutePreUserRegistration: async (
          _: HookEvent,
          api: OnExecutePreUserRegistrationAPI,
        ) => {
          api.access.deny("unauthorized", "Registration not allowed");
        },
      },
    });

    const client = testClient(managementApp, env);
    const token = await getAdminToken();

    const response = await client.users.$post(
      {
        json: {
          email: "denied@example.com",
          connection: Strategy.USERNAME_PASSWORD,
        },
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

    expect(response.status).toBe(400);
    const error = (await response.json()) as { message: string };
    expect(error.message).toContain("Registration denied");
  });

  it("should continue user creation when hook throws a generic error", async () => {
    const { env, managementApp } = await getTestServer({
      hooks: {
        onExecutePreUserRegistration: async () => {
          throw new Error("Something went wrong");
        },
      },
    });

    const client = testClient(managementApp, env);
    const token = await getAdminToken();

    const response = await client.users.$post(
      {
        json: {
          email: "error-but-continues@example.com",
          connection: Strategy.USERNAME_PASSWORD,
        },
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

    expect(response.status).toBe(201);
  });

  it("should block user creation when deny() is called with code only", async () => {
    const { env, managementApp } = await getTestServer({
      hooks: {
        onExecutePreUserRegistration: async (
          _: HookEvent,
          api: OnExecutePreUserRegistrationAPI,
        ) => {
          api.access.deny("blocked");
        },
      },
    });

    const client = testClient(managementApp, env);
    const token = await getAdminToken();

    const response = await client.users.$post(
      {
        json: {
          email: "blocked@example.com",
          connection: Strategy.USERNAME_PASSWORD,
        },
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

    expect(response.status).toBe(400);
    const error = (await response.json()) as { message: string };
    expect(error.message).toBe("Registration denied: blocked");
  });
});
