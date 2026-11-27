import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IGNORE_MARKER,
  checkDocs,
  extractCodeBlocks,
  extractImports,
  resolveSpecifier,
  splitSpecifier,
  suggestPackage,
} from "./docs-imports.mjs";

const fence = "```";

test("extractCodeBlocks reports language and the line of the first code line", () => {
  const blocks = extractCodeBlocks(
    ["# Title", "", `${fence}ts`, 'import { a } from "x";', fence].join("\n"),
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lang, "ts");
  assert.equal(blocks[0].line, 4);
  assert.equal(blocks[0].code, 'import { a } from "x";');
  assert.equal(blocks[0].ignored, false);
});

test("extractCodeBlocks dedents fences nested in list items", () => {
  const blocks = extractCodeBlocks(
    [
      "1. Step",
      "",
      `   ${fence}typescript`,
      '   import { a } from "x";',
      `   ${fence}`,
    ].join("\n"),
  );
  assert.equal(blocks[0].lang, "typescript");
  assert.equal(blocks[0].code, 'import { a } from "x";');
});

test("extractCodeBlocks reads the language of code-group and meta fences", () => {
  const blocks = extractCodeBlocks(
    [`${fence}ts [app.ts]`, "1", fence, `${fence}js{2}`, "2", fence].join("\n"),
  );
  assert.deepEqual(
    blocks.map((block) => block.lang),
    ["ts", "js"],
  );
});

test("extractCodeBlocks honours the ignore marker on the line before a fence", () => {
  const blocks = extractCodeBlocks(
    [
      IGNORE_MARKER,
      `${fence}ts`,
      "old",
      fence,
      "",
      `${fence}ts`,
      "new",
      fence,
    ].join("\n"),
  );
  assert.deepEqual(
    blocks.map((block) => block.ignored),
    [true, false],
  );
});

test("extractCodeBlocks does not split a longer outer fence on an inner one", () => {
  const blocks = extractCodeBlocks(
    ["````md", `${fence}ts`, 'import { a } from "x";', fence, "````"].join(
      "\n",
    ),
  );
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].lang, "md");
});

test("extractImports returns imported names, not local aliases", () => {
  const imports = extractImports(
    [
      'import createAdapters, { type Database, migrateToLatest as migrate } from "@authhero/kysely-adapter";',
      'import * as schema from "@authhero/drizzle/schema/sqlite";',
      'import "authhero/styles";',
      'export { init } from "authhero";',
    ].join("\n"),
  );
  assert.deepEqual(imports, [
    {
      specifier: "@authhero/kysely-adapter",
      line: 0,
      defaultImport: true,
      names: ["Database", "migrateToLatest"],
    },
    {
      specifier: "@authhero/drizzle/schema/sqlite",
      line: 1,
      defaultImport: false,
      names: [],
    },
    { specifier: "authhero/styles", line: 2, defaultImport: false, names: [] },
    { specifier: "authhero", line: 3, defaultImport: false, names: ["init"] },
  ]);
});

test("splitSpecifier separates scoped and unscoped package names from subpaths", () => {
  assert.deepEqual(splitSpecifier("@authhero/saml/core"), {
    name: "@authhero/saml",
    subpath: "./core",
  });
  assert.deepEqual(splitSpecifier("authhero"), {
    name: "authhero",
    subpath: ".",
  });
});

const fakePackages = new Map([
  [
    "authhero",
    {
      dir: "/repo/packages/authhero",
      manifest: {
        name: "authhero",
        types: "dist/authhero.d.ts",
        exports: {
          ".": { types: "./dist/authhero.d.ts", import: "./dist/authhero.mjs" },
          "./styles": { import: "./dist/tailwind.css" },
        },
      },
    },
  ],
  [
    "@authhero/kysely-adapter",
    {
      dir: "/repo/packages/kysely",
      manifest: { name: "@authhero/kysely-adapter" },
    },
  ],
  [
    "@authhero/drizzle",
    {
      dir: "/repo/packages/drizzle",
      manifest: {
        name: "@authhero/drizzle",
        exports: {
          ".": {
            import: {
              types: "./dist/drizzle.d.mts",
              default: "./dist/drizzle.mjs",
            },
          },
        },
      },
    },
  ],
  [
    "@authhero/widget",
    {
      dir: "/repo/packages/ui-widget",
      manifest: {
        name: "@authhero/widget",
        types: "./dist/types/index.d.ts",
        exports: { ".": "./dist/index.js" },
      },
    },
  ],
]);

test("suggestPackage maps common misnamings to the real package", () => {
  assert.equal(
    suggestPackage("@authhero/kysely", fakePackages),
    "@authhero/kysely-adapter",
  );
  assert.equal(suggestPackage("@authhero/authhero", fakePackages), "authhero");
  assert.equal(suggestPackage("@authhero/unknown", fakePackages), undefined);
});

test("resolveSpecifier rejects unknown packages and unexported subpaths", () => {
  assert.match(
    resolveSpecifier("@authhero/kysely", fakePackages).error,
    /did you mean "@authhero\/kysely-adapter"/,
  );
  assert.match(
    resolveSpecifier("authhero/helpers/outbox-relay", fakePackages).error,
    /is not exported by authhero/,
  );
});

test("resolveSpecifier finds types through nested conditions and string exports", () => {
  assert.equal(
    resolveSpecifier("@authhero/drizzle", fakePackages).typesFile,
    "/repo/packages/drizzle/dist/drizzle.d.mts",
  );
  assert.equal(
    resolveSpecifier("@authhero/widget", fakePackages).typesFile,
    "/repo/packages/ui-widget/dist/types/index.d.ts",
  );
  assert.equal(
    resolveSpecifier("authhero/styles", fakePackages).typesFile,
    undefined,
  );
});

test("checkDocs reads exports through the TypeScript checker", (t) => {
  const root = mkdtempSync(join(tmpdir(), "docs-imports-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const pkg = join(root, "packages", "demo");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "@authhero/demo",
      exports: { ".": { types: "./index.d.ts" } },
    }),
  );
  writeFileSync(
    join(pkg, "index.d.ts"),
    [
      "export declare function real(): void;",
      "export type RealType = string;",
      "export * from './more';",
      "export * as ns from './more';",
      "declare const factory: () => void;",
      "export default factory;",
    ].join("\n"),
  );
  writeFileSync(
    join(pkg, "more.d.ts"),
    "export declare const fromStar: number;",
  );

  const docs = join(root, "docs");
  mkdirSync(join(docs, "changelog"), { recursive: true });
  writeFileSync(
    join(docs, "page.md"),
    [
      "# Page",
      `${fence}ts`,
      'import factory, { real, fromStar, ns, type RealType } from "@authhero/demo";',
      'import { invented } from "@authhero/demo";',
      'import { x } from "@authhero/missing";',
      'import { y } from "some-third-party";',
      fence,
      "",
      IGNORE_MARKER,
      `${fence}ts`,
      'import { removed } from "@authhero/demo";',
      fence,
      `${fence}bash`,
      'import { notCode } from "@authhero/demo";',
      fence,
    ].join("\n"),
  );
  writeFileSync(
    join(docs, "changelog", "2026-01-05.md"),
    `${fence}ts\nimport { historic } from "@authhero/demo";\n${fence}\n`,
  );

  const problems = checkDocs({ repoRoot: root, docsDir: docs });
  assert.deepEqual(problems, [
    {
      file: join("docs", "page.md"),
      line: 5,
      message: '"@authhero/missing" is not a package in this repository',
    },
    {
      file: join("docs", "page.md"),
      line: 4,
      message: '"@authhero/demo" does not export "invented"',
    },
  ]);
});

test("checkDocs asks for a build when declarations are missing", (t) => {
  const root = mkdtempSync(join(tmpdir(), "docs-imports-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const pkg = join(root, "packages", "demo");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "@authhero/demo",
      exports: { ".": { types: "./dist/index.d.ts" } },
    }),
  );
  const docs = join(root, "docs");
  mkdirSync(docs);
  writeFileSync(
    join(docs, "page.md"),
    `${fence}ts\nimport { a } from "@authhero/demo";\n${fence}\n`,
  );

  assert.throws(
    () => checkDocs({ repoRoot: root, docsDir: docs }),
    /build the packages first/,
  );
});
