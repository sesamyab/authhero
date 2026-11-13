import { describe, it, expect } from "vitest";
import { stripSessionTransferToken } from "../../src/utils/session-transfer-token";

describe("stripSessionTransferToken", () => {
  it("returns undefined and empty input as they are", () => {
    expect(stripSessionTransferToken(undefined)).toBeUndefined();
    expect(stripSessionTransferToken("")).toBe("");
  });

  it("returns a URL without the parameter untouched", () => {
    const url = "https://auth.example.com/authorize?client_id=a&state=x%20y";
    expect(stripSessionTransferToken(url)).toBe(url);
  });

  it("removes the parameter from an absolute URL", () => {
    expect(
      stripSessionTransferToken(
        "https://auth.example.com/authorize?client_id=a&session_transfer_token=secret&state=s",
      ),
    ).toBe("https://auth.example.com/authorize?client_id=a&state=s");
  });

  it("removes a percent-encoded parameter name from an absolute URL", () => {
    const stripped = stripSessionTransferToken(
      "https://auth.example.com/authorize?client_id=a&session%5Ftransfer%5Ftoken=secret&state=s",
    );
    expect(stripped).toBe(
      "https://auth.example.com/authorize?client_id=a&state=s",
    );
  });

  it("removes every occurrence, whatever the spelling", () => {
    const stripped = stripSessionTransferToken(
      "https://auth.example.com/authorize?session_transfer_token=one&client_id=a&%73ession_transfer_token=two",
    );
    expect(stripped).toBe("https://auth.example.com/authorize?client_id=a");
  });

  it("removes the parameter from a relative URL", () => {
    expect(
      stripSessionTransferToken(
        "/authorize?client_id=a&session_transfer_token=secret&state=s#frag",
      ),
    ).toBe("/authorize?client_id=a&state=s#frag");
  });

  it("removes a percent-encoded parameter name from a relative URL", () => {
    expect(
      stripSessionTransferToken(
        "/authorize?session%5ftransfer%5ftoken=secret&client_id=a",
      ),
    ).toBe("/authorize?client_id=a");
  });

  it("drops the question mark when no parameter is left", () => {
    expect(
      stripSessionTransferToken("/authorize?session_transfer_token=secret"),
    ).toBe("/authorize");
    expect(
      stripSessionTransferToken(
        "/authorize?session_transfer_token=secret#frag",
      ),
    ).toBe("/authorize#frag");
  });

  it("leaves a relative URL alone when only the value or the fragment names the parameter", () => {
    const inValue = "/authorize?next=session_transfer_token&client_id=a";
    expect(stripSessionTransferToken(inValue)).toBe(inValue);

    const inFragment = "/authorize?client_id=a#session_transfer_token=secret";
    expect(stripSessionTransferToken(inFragment)).toBe(inFragment);
  });

  it("survives a malformed percent sequence in a relative URL", () => {
    expect(
      stripSessionTransferToken(
        "/authorize?bad%ZZ=1&session_transfer_token=secret",
      ),
    ).toBe("/authorize?bad%ZZ=1");
  });
});
