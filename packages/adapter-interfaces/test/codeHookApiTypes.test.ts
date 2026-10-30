import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import {
  CODE_HOOK_API_TYPE_DECLARATIONS,
  getCodeHookApiTypeDeclarations,
} from "../src/types/codeHookApiDeclarations";
import { TRIGGER_API_SHAPES } from "../src/types/codeHookApiShapes";

describe("code Action API types", () => {
  it("keeps the generated declarations current with the TypeScript source", () => {
    execFileSync(process.execPath, [
      fileURLToPath(
        new URL("../scripts/generate-code-hook-api-types.mjs", import.meta.url),
      ),
      "--check",
    ]);
  });

  it("provides self-contained types matching every executor API shape", () => {
    expect(Object.keys(CODE_HOOK_API_TYPE_DECLARATIONS).sort()).toEqual(
      Object.keys(TRIGGER_API_SHAPES).sort(),
    );
    const files = new Map(
      Object.entries(CODE_HOOK_API_TYPE_DECLARATIONS).map(
        ([trigger, declarations]) => [
          path.resolve(`__action_api_${trigger}.ts`),
          `export {};\n${declarations}\n${signatureChecks[trigger] ?? ""}`,
        ],
      ),
    );
    const options: ts.CompilerOptions = {
      strict: true,
      noEmit: true,
      types: [],
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
    };
    const host = ts.createCompilerHost(options);
    const getSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (
      name,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    ) => {
      const content = files.get(name);
      return content === undefined
        ? getSourceFile(
            name,
            languageVersion,
            onError,
            shouldCreateNewSourceFile,
          )
        : ts.createSourceFile(name, content, languageVersion, true);
    };
    const program = ts.createProgram([...files.keys()], options, host);
    const checker = program.getTypeChecker();
    const diagnostics = ts.getPreEmitDiagnostics(program);
    expect(
      diagnostics.map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      ),
    ).toEqual([]);
    for (const [trigger, shape] of Object.entries(TRIGGER_API_SHAPES)) {
      const source = program.getSourceFile(
        path.resolve(`__action_api_${trigger}.ts`),
      )!;
      const declaration = source.statements.find(
        (node): node is ts.TypeAliasDeclaration =>
          ts.isTypeAliasDeclaration(node) && node.name.text === "ActionAPI",
      )!;
      const api = checker.getTypeAtLocation(declaration);
      expect(
        checker
          .getPropertiesOfType(api)
          .map((symbol) => symbol.name)
          .sort(),
        trigger,
      ).toEqual(Object.keys(shape).sort());
      for (const [namespace, methods] of Object.entries(shape)) {
        const symbol = checker.getPropertyOfType(api, namespace)!;
        const namespaceType = checker.getTypeOfSymbolAtLocation(
          symbol,
          declaration,
        );
        expect(
          checker
            .getPropertiesOfType(namespaceType)
            .map((method) => method.name)
            .sort(),
          `${trigger}.${namespace}`,
        ).toEqual([...methods].sort());
      }
    }
  });

  it("normalizes the public post-login alias and rejects unknown triggers", () => {
    expect(getCodeHookApiTypeDeclarations("post-login")).toBe(
      getCodeHookApiTypeDeclarations("post-user-login"),
    );
    expect(() => getCodeHookApiTypeDeclarations("toString")).toThrow(
      "Unsupported action trigger",
    );
  });
});

const signatureChecks: Record<string, string> = {
  "post-user-login": `
    declare const api: ActionAPI;
    api.idToken.setCustomClaim("role", "reader");
    api.redirect.sendUserTo("https://example.com", { query: { next: "/" } });
    const result: void = api.user.setLinkedTo("auth0|123");
    // @ts-expect-error server-side token helpers do not exist in the sandbox
    api.token.createServiceToken({ scope: "read:users" });
    // @ts-expect-error a claim name must be a string
    api.idToken.setCustomClaim(123, "reader");
    // @ts-expect-error query values must be strings
    api.redirect.sendUserTo("https://example.com", { query: { next: 123 } });
  `,
  "credentials-exchange": `
    declare const api: ActionAPI;
    api.access.deny("access_denied", "Reason");
    // @ts-expect-error credentials exchange needs an error code
    api.access.deny();
  `,
  "pre-user-update": `
    declare const api: ActionAPI;
    api.access.deny();
    api.access.deny("Reason");
    // @ts-expect-error server hook cancel is unavailable to code Actions
    api.cancel();
  `,
  "pre-user-registration": `
    declare const api: ActionAPI;
    api.user.setUserMetadata("flag", true);
    api.user.setLinkedTo("auth0|123");
    api.validation.error("invalid", "Reason");
    // @ts-expect-error validation errors need a code and a message
    api.validation.error("invalid");
  `,
  "custom-token-exchange": `
    declare const api: ActionAPI;
    api.authentication.setUserById("auth0|123");
    api.authentication.setUserByConnection("database", { user_id: "123", email_verified: true });
    api.authentication.setUserByConnection("database", { user_id: "123" }, { creationBehavior: "none", updateBehavior: "replace" });
    api.access.rejectInvalidSubjectToken();
    // @ts-expect-error user_id is required
    api.authentication.setUserByConnection("database", { email: "test@example.com" });
    // @ts-expect-error email_verified must be boolean
    api.authentication.setUserByConnection("database", { user_id: "123", email_verified: "true" });
    // @ts-expect-error updateBehavior is a defined enum
    api.authentication.setUserByConnection("database", { user_id: "123" }, { updateBehavior: "always" });
  `,
};
