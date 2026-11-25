import { describe, expect, it } from "vitest";
import {
  credentialString,
  trimCredentialFields,
} from "../src/utils/credentials";
import { connectionOptionsSchema } from "../src/types/Connection";

describe("credentialString", () => {
  it("trims leading and trailing whitespace but keeps inner whitespace", () => {
    expect(credentialString().parse("  abc def\n")).toBe("abc def");
  });

  it("trims credential fields in a schema that uses it", () => {
    const options = connectionOptionsSchema.parse({
      client_id: " id ",
      client_secret: "secret\r\n",
    });
    // client_id is an identifier, not a credential, so it is left alone.
    expect(options.client_id).toBe(" id ");
    expect(options.client_secret).toBe("secret");
  });
});

describe("trimCredentialFields", () => {
  it("trims only the listed string fields and does not mutate the input", () => {
    const input = { api_key: " key\n", smtp_pass: " pass ", port: 25 };
    const result = trimCredentialFields(input, ["api_key", "port", "missing"]);
    expect(result).toEqual({ api_key: "key", smtp_pass: " pass ", port: 25 });
    expect(input.api_key).toBe(" key\n");
  });
});
