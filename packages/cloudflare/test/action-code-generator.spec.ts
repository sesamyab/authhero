import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { getCodeHookApiTypeDeclarations } from "@authhero/adapter-interfaces";
import { CloudflareActionCodeGenerator } from "../src/action-code-generator";

// Run the same real HTTP checks standalone in CI or through Postman.
const require = createRequire(import.meta.url);
let server: Server | undefined;
let baseUrl = process.env.CLOUDFLARE_AI_SIMULATION_URL;
beforeAll(async () => {
  if (baseUrl) return;
  server = createServer(
    require("../../../postman/mocks/cloudflare-action-generation/default.js"),
  );
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No mock HTTP address");
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
});

const params = {
  tenantId: "tenant",
  triggerId: "post-login",
  model: "glm" as const,
  prompt: "Add a role",
  apiTypes: getCodeHookApiTypeDeclarations("post-login"),
};
function generator(timeoutMs?: number, models?: { glm: string }) {
  return new CloudflareActionCodeGenerator({
    accountId: "test-account",
    apiToken: "test-token",
    gatewayId: "test-gateway",
    timeoutMs,
    models,
    fetch: async (input, init) => {
      const upstream = new URL(String(input));
      expect(upstream.origin).toBe("https://api.cloudflare.com");
      const request = JSON.parse(String(init?.body));
      expect(request.model).toBe(models?.glm ?? "@cf/zai-org/glm-4.7-flash");
      expect(request.messages[0].content).toContain(
        '"idToken":["setCustomClaim"]',
      );
      expect(request.messages[0].content).not.toContain("test-token");
      expect(request.messages[0].content).toContain(params.apiTypes);
      expect(request.messages[0].content).toContain("Output JavaScript only");
      return fetch(`${baseUrl}${upstream.pathname}`, init);
    },
  });
}

describe("Cloudflare action generation over HTTP", () => {
  it("sends the documented gateway contract and extracts fenced source", async () => {
    const result = await generator().generate(params);
    expect(result.code).toBe(
      "exports.onExecutePostLogin = async (event, api) => { api.idToken.setCustomClaim('role', 'reader'); };",
    );
  });
  it("allows deployments to override model versions", async () => {
    expect(
      (await generator(undefined, { glm: "custom/glm" }).generate(params)).code,
    ).toContain("exports.onExecutePostLogin");
  });
  it.each(["glm", "deepseek", "qwen"] as const)(
    "supports the %s model choice",
    async (model) => {
      const expected = {
        glm: "@cf/zai-org/glm-4.7-flash",
        deepseek: "@cf/deepseek-ai/deepseek-v4-flash-0731",
        qwen: "@cf/qwen/qwen3.8-27b",
      };
      const adapter = new CloudflareActionCodeGenerator({
        accountId: "test-account",
        apiToken: "test-token",
        gatewayId: "test-gateway",
        fetch: async (input, init) => {
          expect(JSON.parse(String(init?.body)).model).toBe(expected[model]);
          return fetch(`${baseUrl}${new URL(String(input)).pathname}`, init);
        },
      });
      expect((await adapter.generate({ ...params, model })).code).toContain(
        "exports.onExecutePostLogin",
      );
    },
  );
  it("handles upstream errors without exposing response bodies", async () => {
    await expect(
      generator().generate({ ...params, prompt: "upstream-error" }),
    ).rejects.toThrow("AI Gateway request failed (503)");
  });
  it.each(["invalid-json", "truncated", "empty"])(
    "rejects %s responses",
    async (prompt) => {
      await expect(
        generator().generate({ ...params, prompt }),
      ).rejects.toThrow();
    },
  );
  it("aborts requests that exceed the configured timeout", async () => {
    await expect(
      generator(30).generate({ ...params, prompt: "hang" }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
