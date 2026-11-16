import { describe, it, expect } from "vitest";
import { resolveSessionTransfer } from "@authhero/adapter-interfaces";
import {
  acceptsUnboundQueryTokens,
  isDeviceBinding,
  toggleAuthenticationMethod,
} from "./sessionTransfer";

describe("toggleAuthenticationMethod", () => {
  it("adds a method", () => {
    expect(toggleAuthenticationMethod([], "query", true)).toEqual(["query"]);
  });

  it("keeps a stable order whatever order the boxes were ticked in", () => {
    expect(toggleAuthenticationMethod(["query"], "cookie", true)).toEqual([
      "cookie",
      "query",
    ]);
  });

  it("removes a method and leaves the other", () => {
    expect(
      toggleAuthenticationMethod(["cookie", "query"], "cookie", false),
    ).toEqual(["query"]);
  });

  it("does not duplicate a method that is already on", () => {
    expect(toggleAuthenticationMethod(["query"], "query", true)).toEqual([
      "query",
    ]);
  });

  it("removing a method that is not on changes nothing", () => {
    expect(toggleAuthenticationMethod(["cookie"], "query", false)).toEqual([
      "cookie",
    ]);
  });
});

describe("isDeviceBinding", () => {
  it("accepts the three bindings and nothing else", () => {
    expect(isDeviceBinding("ip")).toBe(true);
    expect(isDeviceBinding("asn")).toBe(true);
    expect(isDeviceBinding("none")).toBe(true);
    expect(isDeviceBinding("")).toBe(false);
    expect(isDeviceBinding(undefined)).toBe(false);
  });
});

describe("acceptsUnboundQueryTokens", () => {
  it("is false for a client that never configured session transfer", () => {
    expect(acceptsUnboundQueryTokens(resolveSessionTransfer({}))).toBe(false);
  });

  it("is false for query tokens under the default IP binding", () => {
    expect(
      acceptsUnboundQueryTokens(
        resolveSessionTransfer({ allowed_authentication_methods: ["query"] }),
      ),
    ).toBe(false);
  });

  it("is true for query tokens with device binding off", () => {
    expect(
      acceptsUnboundQueryTokens(
        resolveSessionTransfer({
          allowed_authentication_methods: ["cookie", "query"],
          enforce_device_binding: "none",
        }),
      ),
    ).toBe(true);
  });

  it("is false for cookie-only redemption with device binding off", () => {
    expect(
      acceptsUnboundQueryTokens(
        resolveSessionTransfer({
          allowed_authentication_methods: ["cookie"],
          enforce_device_binding: "none",
        }),
      ),
    ).toBe(false);
  });
});
