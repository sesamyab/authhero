import { describe, expect, it } from "vitest";
import { verifyActionCode } from "../../src/helpers/action-verification";

const triggers = [{ id: "post-login" }];
describe("static action verification", () => {
  it("accepts the Auth0 trigger alias and supported API calls", () => {
    expect(
      verifyActionCode(
        'exports.onExecutePostLogin = async (event, api) => { api.idToken.setCustomClaim("role", "reader"); };',
        triggers,
      ),
    ).toEqual({ valid: true, errors: [] });
  });
  it.each([
    ["syntax", "exports.onExecutePostLogin = async ( => {}"],
    ["missing export", "// exports.onExecutePostLogin = async () => {}"],
    ["wrong handler", "exports.onExecutePreUserRegistration = async () => {};"],
    ["nonfunction export", "exports.onExecutePostLogin = 123;"],
    [
      "unsupported API",
      "exports.onExecutePostLogin = async (event, api) => { api.user.setAppMetadata('x', 1); };",
    ],
    [
      "prototype namespace",
      "exports.onExecutePostLogin = async (event, api) => { api.__proto__.invalid(); };",
    ],
    [
      "ES modules",
      "import x from 'fs'; exports.onExecutePostLogin = async () => {};",
    ],
  ])("rejects %s", (_, code) => {
    expect(verifyActionCode(code, triggers).valid).toBe(false);
  });
  it("checks every trigger and rejects unknown triggers", () => {
    const code = "exports.onExecutePostLogin = async () => {};";
    expect(
      verifyActionCode(code, [...triggers, { id: "pre-user-registration" }])
        .valid,
    ).toBe(false);
    expect(verifyActionCode(code, [{ id: "toString" }]).valid).toBe(false);
    expect(verifyActionCode(code, []).valid).toBe(false);
  });
  it.each([
    ["const arrow", "const onExecute = async (event, api) => {};"],
    ["let function expression", "let onExecute = async function () {};"],
    ["function declaration", "async function onExecute() {}"],
  ])("accepts an export bound to a %s", (_, declaration) => {
    expect(
      verifyActionCode(
        `${declaration} exports.onExecutePostLogin = onExecute;`,
        triggers,
      ),
    ).toEqual({ valid: true, errors: [] });
  });
  it("rejects an export bound to a non-function variable", () => {
    expect(
      verifyActionCode(
        "const onExecute = 123; exports.onExecutePostLogin = onExecute;",
        triggers,
      ).valid,
    ).toBe(false);
  });
  it("never executes top-level code", () => {
    expect(
      verifyActionCode(
        'throw new Error("must not execute"); exports.onExecutePostLogin = async () => {};',
        triggers,
      ).valid,
    ).toBe(true);
  });
});
