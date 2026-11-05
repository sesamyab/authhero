import { describe, it, expect } from "vitest";
import { getClientShape } from "./shape";

const regularWeb = {
  showSecret: true,
  showCallbacks: true,
  isInteractive: true,
  showSso: true,
  showClientGrants: false,
  isExternallyManaged: false,
};

describe("getClientShape", () => {
  it("treats an undefined record as a regular web app", () => {
    expect(getClientShape(undefined)).toEqual(regularWeb);
  });

  it("treats a record without app_type as a regular web app", () => {
    expect(getClientShape({})).toEqual(regularWeb);
  });

  it("treats regular_web as a confidential interactive client", () => {
    expect(getClientShape({ app_type: "regular_web" })).toEqual(regularWeb);
  });

  it("shows client grants for a regular web app with client_credentials", () => {
    expect(
      getClientShape({
        app_type: "regular_web",
        grant_types: ["authorization_code", "client_credentials"],
      }).showClientGrants,
    ).toBe(true);
  });

  it("hides the secret and client grants for spa", () => {
    expect(getClientShape({ app_type: "spa" })).toEqual({
      showSecret: false,
      showCallbacks: true,
      isInteractive: true,
      showSso: true,
      showClientGrants: false,
      isExternallyManaged: false,
    });
  });

  it("does not show client grants for a public client with client_credentials", () => {
    expect(
      getClientShape({
        app_type: "spa",
        grant_types: ["client_credentials"],
        token_endpoint_auth_method: "none",
      }).showClientGrants,
    ).toBe(false);
  });

  it("shows client grants for a spa or native client that still has a secret", () => {
    for (const app_type of ["spa", "native"]) {
      expect(
        getClientShape({
          app_type,
          grant_types: ["client_credentials"],
          token_endpoint_auth_method: "client_secret_basic",
        }).showClientGrants,
      ).toBe(true);
    }
  });

  it("hides the secret, SSO and client grants for native", () => {
    expect(getClientShape({ app_type: "native" })).toEqual({
      showSecret: false,
      showCallbacks: true,
      isInteractive: true,
      showSso: false,
      showClientGrants: false,
      isExternallyManaged: false,
    });
  });

  it("keeps SSO visible for a native app that already has a SAML addon", () => {
    expect(
      getClientShape({ app_type: "native", addons: { samlp: {} } }).showSso,
    ).toBe(true);
  });

  it("shows only secret and client grants for non_interactive (M2M)", () => {
    expect(getClientShape({ app_type: "non_interactive" })).toEqual({
      showSecret: true,
      showCallbacks: false,
      isInteractive: false,
      showSso: false,
      showClientGrants: true,
      isExternallyManaged: false,
    });
  });

  it("falls back to the regular web shape for unknown app types", () => {
    expect(getClientShape({ app_type: "something_new" })).toEqual(regularWeb);
  });

  it("marks CIMD clients as externally managed public clients", () => {
    expect(getClientShape({ client_metadata: { cimd: "true" } })).toEqual({
      showSecret: false,
      showCallbacks: true,
      isInteractive: true,
      showSso: false,
      showClientGrants: false,
      isExternallyManaged: true,
    });
  });

  it("lets the CIMD flag win over app_type", () => {
    expect(
      getClientShape({
        app_type: "non_interactive",
        client_metadata: { cimd: "true" },
      }),
    ).toEqual({
      showSecret: false,
      showCallbacks: true,
      isInteractive: true,
      showSso: false,
      showClientGrants: false,
      isExternallyManaged: true,
    });
  });

  it("only treats the exact string 'true' as CIMD", () => {
    expect(
      getClientShape({ client_metadata: { cimd: "false" } })
        .isExternallyManaged,
    ).toBe(false);
    expect(
      getClientShape({ client_metadata: { cimd: true } }).isExternallyManaged,
    ).toBe(false);
    expect(getClientShape({ client_metadata: null }).isExternallyManaged).toBe(
      false,
    );
  });
});
