import { describe, expect, it } from "vitest";
import { getAdminToken } from "../../helpers/token";
import { getTestServer } from "../../helpers/test-server";

describe("rollout management API errors", () => {
  it.each([
    ["GET", "/rollouts/missing"],
    ["POST", "/rollouts/missing/pause"],
    ["POST", "/rollouts/missing/resume"],
  ])("returns a typed 404 for %s %s", async (method, path) => {
    const { managementApp, env } = await getTestServer();
    env.rolloutController = {
      create: async () => {
        throw new Error("must not create a rollout");
      },
      pause: async () => null,
      resume: async () => null,
    };
    const token = await getAdminToken({
      scope: "read:rollouts update:rollouts",
    });
    const response = await managementApp.request(
      path,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "tenant-id": "tenantId",
        },
      },
      env,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      statusCode: 404,
      error: "Not Found",
      message: "The rollout does not exist.",
      errorCode: "inexistent_rollout",
    });
  });

  it("identifies invalid rollout query parameters", async () => {
    const { managementApp, env } = await getTestServer();
    const token = await getAdminToken({ scope: "read:rollouts" });
    const response = await managementApp.request(
      "/rollouts?per_page=101",
      {
        headers: {
          authorization: `Bearer ${token}`,
          "tenant-id": "tenantId",
        },
      },
      env,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      statusCode: 400,
      error: "Bad Request",
      message:
        "Query validation error: 'Value 101 is greater than maximum 100' on property per_page.",
      errorCode: "invalid_query_string",
    });
  });
});
