import { readFileSync, writeFileSync } from "node:fs";
import ts from "typescript";

const sourcePath = new URL("../src/types/codeHookApiTypes.ts", import.meta.url);
const targetPath = new URL(
  "../src/types/codeHookApiDeclarations.generated.json",
  import.meta.url,
);
const source = ts.createSourceFile(
  sourcePath.pathname,
  readFileSync(sourcePath, "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const declarations = new Map(
  source.statements
    .filter(
      (node) =>
        ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node),
    )
    .map((node) => [node.name.text, node]),
);
const contract = declarations.get("CodeHookApiByTrigger");
if (!contract || !ts.isInterfaceDeclaration(contract))
  throw new Error("Missing code Action API contract");
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
const print = (node) =>
  printer.printNode(ts.EmitHint.Unspecified, node, source);

function withoutExport(node) {
  const modifiers = node.modifiers?.filter(
    (modifier) => modifier.kind !== ts.SyntaxKind.ExportKeyword,
  );
  return ts.isInterfaceDeclaration(node)
    ? ts.factory.updateInterfaceDeclaration(
        node,
        modifiers,
        node.name,
        node.typeParameters,
        node.heritageClauses,
        node.members,
      )
    : ts.factory.updateTypeAliasDeclaration(
        node,
        modifiers,
        node.name,
        node.typeParameters,
        node.type,
      );
}

const output = {};
for (const member of contract.members) {
  if (
    !ts.isPropertySignature(member) ||
    !member.type ||
    !ts.isStringLiteral(member.name)
  )
    throw new Error("Expected a named trigger API type");
  const dependencies = new Set();
  function collect(node) {
    // Heritage clauses use ExpressionWithTypeArguments rather than TypeReference.
    const reference = ts.isTypeReferenceNode(node)
      ? node.typeName
      : ts.isExpressionWithTypeArguments(node)
        ? node.expression
        : undefined;
    if (
      reference &&
      ts.isIdentifier(reference) &&
      declarations.has(reference.text) &&
      !dependencies.has(reference.text)
    ) {
      dependencies.add(reference.text);
      collect(declarations.get(reference.text));
    }
    ts.forEachChild(node, collect);
  }
  collect(member.type);
  output[member.name.text] = [
    "// Code Action sandbox API. Calls are recorded and applied after the handler completes; methods return no result.",
    ...[...dependencies].map((name) =>
      print(withoutExport(declarations.get(name))),
    ),
    `type ActionAPI = ${print(member.type)};`,
  ].join("\n\n");
}
const serialized = `${JSON.stringify(output, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(targetPath, "utf8") !== serialized) {
    throw new Error(
      "Action API declarations are stale. Run pnpm --filter @authhero/adapter-interfaces generate:action-types",
    );
  }
} else {
  writeFileSync(targetPath, serialized);
}
