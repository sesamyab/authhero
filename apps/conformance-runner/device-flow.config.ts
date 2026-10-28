import { defineConfig, devices } from "@playwright/test";

// RFC 8628 browser/protocol checks, separate from the OIDF runner: the pinned
// OIDF suite has no device-grant plan, and these tests need no Docker services.
const port = Number(process.env.DEVICE_FLOW_TEST_PORT || 3100);
export default defineConfig({
  testDir: "./tests",
  testMatch: "device-flow.spec.ts",
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  outputDir: "./device-flow-results",
  reporter: [
    ["list"],
    ["html", { outputFolder: "device-flow-report", open: "never" }],
  ],
  use: { baseURL: `http://localhost:${port}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command:
      "pnpm authhero exec tsx test/helpers/device-flow-browser-server.mts",
    cwd: "../..",
    url: `http://localhost:${port}/.well-known/openid-configuration`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { DEVICE_FLOW_TEST_PORT: String(port) },
  },
});
