import { describe, it, expect } from "vitest";
import {
  redactSessionTransferQuery,
  stripSessionTransferToken,
} from "../../src/utils/session-transfer-token";

// A compact JWT as it travels in the `request` parameter. The signature is
// never looked at here.
function requestObject(claims: Record<string, unknown>): string {
  const segment = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${segment({ alg: "RS256", kid: "k" })}.${segment(claims)}.c2lnbmF0dXJl`;
}

const CARRIER = requestObject({
  client_id: "a",
  session_transfer_token: "secret",
});
const PLAIN = requestObject({ client_id: "a", scope: "openid" });
// A JWE has five segments and no readable payload.
const ENCRYPTED = "eyJhbGciOiJSU0EtT0FFUCJ9.a2V5.aXY.Y2lwaGVy.dGFn";

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

  describe("request objects", () => {
    it("removes a request object that carries the token", () => {
      expect(
        stripSessionTransferToken(
          `https://auth.example.com/authorize?client_id=a&request=${CARRIER}&state=s`,
        ),
      ).toBe("https://auth.example.com/authorize?client_id=a&state=s");
    });

    it("removes it together with a token next to it", () => {
      expect(
        stripSessionTransferToken(
          `https://auth.example.com/authorize?request=${CARRIER}&client_id=a&session_transfer_token=other`,
        ),
      ).toBe("https://auth.example.com/authorize?client_id=a");
    });

    it("removes it from a relative URL, whatever the spelling of the name", () => {
      expect(
        stripSessionTransferToken(
          `/authorize?client_id=a&request=${CARRIER}#frag`,
        ),
      ).toBe("/authorize?client_id=a#frag");
      expect(
        stripSessionTransferToken(
          `/authorize?%72equest=${CARRIER}&client_id=a`,
        ),
      ).toBe("/authorize?client_id=a");
    });

    it("keeps a request object without the token", () => {
      const absolute = `https://auth.example.com/authorize?client_id=a&request=${PLAIN}`;
      expect(stripSessionTransferToken(absolute)).toBe(absolute);

      const relative = `/authorize?client_id=a&request=${PLAIN}`;
      expect(stripSessionTransferToken(relative)).toBe(relative);
    });

    it("keeps a request value it cannot read", () => {
      for (const value of [ENCRYPTED, "not-a-jwt", "a.b.c", "", "a.bnVsbA.c"]) {
        const absolute = `https://auth.example.com/authorize?client_id=a&request=${value}`;
        expect(stripSessionTransferToken(absolute)).toBe(absolute);

        const relative = `/authorize?client_id=a&request=${value}`;
        expect(stripSessionTransferToken(relative)).toBe(relative);
      }
    });

    it("keeps the token on a parameter that is not the request object", () => {
      const url = `https://auth.example.com/authorize?client_id=a&id_token_hint=${CARRIER}`;
      expect(stripSessionTransferToken(url)).toBe(url);
    });
  });
});

describe("redactSessionTransferQuery", () => {
  it("returns a query without the token as it is", () => {
    const query = { client_id: "a", request: PLAIN };
    expect(redactSessionTransferQuery(query)).toBe(query);

    const empty = {};
    expect(redactSessionTransferQuery(empty)).toBe(empty);
  });

  it("redacts the parameter", () => {
    expect(
      redactSessionTransferQuery({
        client_id: "a",
        session_transfer_token: "secret",
      }),
    ).toEqual({ client_id: "a", session_transfer_token: "[REDACTED]" });
  });

  it("redacts a request object that carries the token", () => {
    expect(
      redactSessionTransferQuery({ client_id: "a", request: CARRIER }),
    ).toEqual({ client_id: "a", request: "[REDACTED]" });
  });

  it("redacts it in a list of values and in a comma-joined value", () => {
    expect(
      redactSessionTransferQuery({
        client_id: ["a"],
        request: [PLAIN, CARRIER],
      }),
    ).toEqual({ client_id: ["a"], request: "[REDACTED]" });
    expect(
      redactSessionTransferQuery({ request: `${PLAIN},${CARRIER}` }),
    ).toEqual({ request: "[REDACTED]" });
  });

  it("redacts both when both are there", () => {
    expect(
      redactSessionTransferQuery({
        request: CARRIER,
        session_transfer_token: "other",
      }),
    ).toEqual({ request: "[REDACTED]", session_transfer_token: "[REDACTED]" });
  });

  it("keeps a request value it cannot read", () => {
    for (const request of [ENCRYPTED, "not-a-jwt", "a.b.c", ""]) {
      const query = { client_id: "a", request };
      expect(redactSessionTransferQuery(query)).toBe(query);
    }
  });

  it("does not change the query it was given", () => {
    const query = { request: CARRIER, session_transfer_token: "secret" };
    redactSessionTransferQuery(query);
    expect(query).toEqual({
      request: CARRIER,
      session_transfer_token: "secret",
    });
  });
});
