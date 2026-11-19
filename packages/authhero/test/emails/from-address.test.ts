import { describe, it, expect } from "vitest";
import { resolveFromAddress } from "../../src/emails/from-address";

const env = { ISSUER: "https://auth.example.com/" };

describe("resolveFromAddress", () => {
  it("prefers the email provider's default_from_address", () => {
    expect(
      resolveFromAddress({
        env: { ...env, DEFAULT_SENDER_EMAIL: "d@example.com" },
        provider: { default_from_address: "p@example.com" },
        tenant: { sender_email: "t@example.com" },
      }),
    ).toBe("p@example.com");
  });

  it("uses the tenant sender with its name, else friendly_name", () => {
    expect(
      resolveFromAddress({
        env,
        tenant: {
          sender_email: "t@example.com",
          sender_name: "Acme",
          friendly_name: "Acme Inc.",
        },
      }),
    ).toBe("Acme <t@example.com>");
    expect(
      resolveFromAddress({
        env,
        tenant: { sender_email: "t@example.com", friendly_name: "Acme Inc." },
      }),
    ).toBe('"Acme Inc." <t@example.com>');
  });

  it("quotes and escapes a display name that is not plain words", () => {
    const from = (name: string) =>
      resolveFromAddress({
        env,
        tenant: { sender_email: "t@example.com", sender_name: name },
      });
    expect(from("Acme, Inc.")).toBe('"Acme, Inc." <t@example.com>');
    expect(from('The "Best" Co')).toBe('"The \\"Best\\" Co" <t@example.com>');
    expect(from("Back\\slash")).toBe('"Back\\\\slash" <t@example.com>');
    expect(from("Evil\r\nBcc: x@y.z")).toBe(
      '"Evil  Bcc: x@y.z" <t@example.com>',
    );
  });

  it("uses DEFAULT_SENDER_EMAIL when the tenant has no sender", () => {
    expect(
      resolveFromAddress({
        env: { ...env, DEFAULT_SENDER_EMAIL: "no-reply@example.net" },
        provider: {},
        tenant: {},
      }),
    ).toBe("no-reply@example.net");
  });

  it("falls back to login@ the issuer's hostname, not the whole URL", () => {
    expect(resolveFromAddress({ env })).toBe("login@auth.example.com");
    expect(
      resolveFromAddress({ env: { ISSUER: "https://localhost:3000/" } }),
    ).toBe("login@localhost");
  });
});
