import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyActionBeforeSave } from "./api";

const httpClient = vi.fn();
vi.mock("@/authProvider", () => ({
  authorizedHttpClient: (...args: unknown[]) => httpClient(...args),
  createOrganizationHttpClient: () => httpClient,
  isSingleTenantForDomain: () => true,
}));
vi.mock("@/utils/domainUtils", () => ({
  buildUrlWithProtocol: (url: string) => `https://${url}`,
  formatDomain: (url: string) => url,
  getDomainFromStorage: () => [],
  getSelectedDomainFromStorage: () => "auth.example.com",
}));
vi.mock("@/utils/runtimeConfig", () => ({ getConfigValue: () => undefined }));

afterEach(() => {
  vi.clearAllMocks();
});

const action = {
  code: "exports.onExecutePostLogin = async () => {};",
  supported_triggers: [{ id: "post-login" }],
};

function respond(responses: Record<string, unknown | Error>) {
  httpClient.mockImplementation(async (url: string) => {
    const path = url.split("/").pop() ?? "";
    const response = responses[path];
    if (response instanceof Error) throw response;
    return { json: response };
  });
}

describe("verifyActionBeforeSave", () => {
  it("rejects unverified source when the server enforces verification", async () => {
    respond({
      generation: { models: ["glm"], verification_required: true },
      verify: { valid: false, errors: ["Define the trigger handler."] },
    });

    await expect(verifyActionBeforeSave(action, "tenant")).rejects.toThrow(
      "Action verification failed: Define the trigger handler.",
    );
  });

  it("skips verification when the server doesn't enforce it", async () => {
    respond({ generation: { models: [], verification_required: false } });

    await expect(verifyActionBeforeSave(action, "tenant")).resolves.toBe(
      action,
    );
    expect(httpClient).toHaveBeenCalledTimes(1);
  });

  it("skips verification on servers without the generation route", async () => {
    respond({ generation: new Error("Not Found") });

    await expect(verifyActionBeforeSave(action, "tenant")).resolves.toBe(
      action,
    );
    expect(httpClient).toHaveBeenCalledTimes(1);
  });
});
