// Lazy env reads via getters so values reflect any process.env mutation that
// happens during prepareAuthServer (e.g. AUTHHERO_ISSUER auto-detection).
// Without getters, `env.authheroIssuer` is frozen to whatever was in
// process.env at module-import time, which is too early — playwright.config
// imports this module before the suite container is up and discoverable.

function parseBool(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.toLowerCase();
  return v !== "0" && v !== "false" && v !== "no";
}

function parseBoolWithDefault(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined) return defaultValue;
  const v = value.toLowerCase();
  return v !== "0" && v !== "false" && v !== "no" && v !== "";
}

function scheme(): "http" | "https" {
  return parseBoolWithDefault(process.env.HTTPS_ENABLED, true)
    ? "https"
    : "http";
}

export const env = {
  get conformanceBaseUrl(): string {
    return (
      process.env.CONFORMANCE_BASE_URL ?? "https://localhost.emobix.co.uk:8443"
    );
  },
  get authheroBaseUrl(): string {
    return process.env.AUTHHERO_BASE_URL ?? `${scheme()}://localhost:3000`;
  },
  get authheroIssuer(): string {
    return (
      process.env.AUTHHERO_ISSUER ?? `${scheme()}://host.docker.internal:3000/`
    );
  },
  get username(): string {
    return process.env.CONFORMANCE_USERNAME ?? "admin";
  },
  get password(): string {
    return process.env.CONFORMANCE_PASSWORD ?? "password2";
  },
  get alias(): string {
    return process.env.CONFORMANCE_ALIAS ?? "my-local-test";
  },
  get allowWarning(): boolean {
    return parseBool(process.env.ALLOW_WARNING);
  },
  get skipSetup(): boolean {
    return parseBool(process.env.SKIP_SETUP);
  },
  get httpsEnabled(): boolean {
    return parseBoolWithDefault(process.env.HTTPS_ENABLED, true);
  },
};
