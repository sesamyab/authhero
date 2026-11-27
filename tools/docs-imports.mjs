#!/usr/bin/env node
/**
 * Checks the imports in the code samples of the docs site (apps/docs).
 *
 * Every `import … from "<package>"` in a TypeScript or JavaScript code block
 * that names a workspace package (`authhero`, `@authhero/*`, `create-authhero`)
 * must:
 *
 *   - name a package that exists in packages/ — `@authhero/kysely` is not
 *     `@authhero/kysely-adapter`;
 *   - use a subpath the package exports in its package.json `exports` map;
 *   - import only names the package actually exports, read from its built
 *     type declarations with the TypeScript checker, so `export *` re-exports,
 *     `export * as ns` and type-only exports all count.
 *
 * The packages must be built first (`pnpm -r --filter './packages/**' build`),
 * as CI does before its lint step.
 *
 * A code block that deliberately shows an API that no longer exists — the
 * "before" half of a migration guide — can opt out with an HTML comment on the
 * line before its opening fence:
 *
 *   <!-- docs-imports-ignore -->
 *   ```ts
 *   import { removedHelper } from "authhero";
 *   ```
 *
 * Usage: node tools/docs-imports.mjs [docs-dir]
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const IGNORE_MARKER = "<!-- docs-imports-ignore -->";

const SKIPPED_DIRS = new Set(["node_modules", "dist", "cache", "changelog"]);
const SKIPPED_FILES = new Set(["CHANGELOG.md"]);

/**
 * Splits a Markdown document into its fenced code blocks.
 *
 * Fences may be indented (code blocks inside list items); the indentation of
 * the opening fence is removed from every line of the block. `line` is the
 * 1-based line number of the first line of code in the document. A fence that
 * is never closed runs to the end of the document, as in CommonMark.
 */
export function extractCodeBlocks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const blocks = [];
  let open = null;
  let previousNonBlank = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!open) {
      const match = /^(\s*)(`{3,}|~{3,})\s*([^\s`{[]*)/.exec(line);
      if (match) {
        open = {
          indent: match[1].length,
          fence: match[2],
          lang: match[3].toLowerCase(),
          ignored: previousNonBlank.trim() === IGNORE_MARKER,
          start: i + 2,
          body: [],
        };
      } else if (line.trim() !== "") {
        previousNonBlank = line;
      }
      continue;
    }

    // A closing fence uses the opening fence's character, is at least as long,
    // and carries no info string.
    const closing = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
    if (
      closing &&
      closing[1][0] === open.fence[0] &&
      closing[1].length >= open.fence.length
    ) {
      blocks.push({
        lang: open.lang,
        ignored: open.ignored,
        line: open.start,
        code: open.body.join("\n"),
      });
      open = null;
      previousNonBlank = line;
      continue;
    }
    open.body.push(removeIndent(line, open.indent));
  }
  if (open) {
    blocks.push({
      lang: open.lang,
      ignored: open.ignored,
      line: open.start,
      code: open.body.join("\n"),
    });
  }
  return blocks;
}

function removeIndent(line, indent) {
  let i = 0;
  while (i < indent && i < line.length && line[i] === " ") i++;
  return line.slice(i);
}

// The fence languages this check reads, with how TypeScript parses each and
// the file extension that goes with it.
const SCRIPT_KINDS = {
  ts: [ts.ScriptKind.TS, "ts"],
  typescript: [ts.ScriptKind.TS, "ts"],
  mts: [ts.ScriptKind.TS, "ts"],
  cts: [ts.ScriptKind.TS, "ts"],
  tsx: [ts.ScriptKind.TSX, "tsx"],
  js: [ts.ScriptKind.JS, "js"],
  javascript: [ts.ScriptKind.JS, "js"],
  mjs: [ts.ScriptKind.JS, "js"],
  cjs: [ts.ScriptKind.JS, "js"],
  jsx: [ts.ScriptKind.JSX, "jsx"],
};

/**
 * Returns the static imports and re-exports of a code sample.
 *
 * The sample is parsed according to its fence language: as TSX only when it is
 * marked `tsx`, because in TSX a type assertion such as `<string>value` reads
 * as JSX and can swallow the statements after it.
 *
 * Each entry has the module specifier, the 0-based line within the sample,
 * whether it imports the default export, and the names it imports by name
 * (the exported name, not the local alias).
 */
export function extractImports(code, lang = "ts") {
  const [scriptKind, extension] = SCRIPT_KINDS[lang] ?? SCRIPT_KINDS.ts;
  const source = ts.createSourceFile(
    `sample.${extension}`,
    code,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const imports = [];
  for (const statement of source.statements) {
    const isImport = ts.isImportDeclaration(statement);
    const isReExport =
      ts.isExportDeclaration(statement) && statement.moduleSpecifier;
    if (!isImport && !isReExport) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;

    const entry = {
      specifier: statement.moduleSpecifier.text,
      line: source.getLineAndCharacterOfPosition(statement.getStart(source))
        .line,
      defaultImport: false,
      names: [],
    };

    if (isImport) {
      const clause = statement.importClause;
      if (clause?.name) entry.defaultImport = true;
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          entry.names.push((element.propertyName ?? element.name).text);
        }
      }
    } else if (
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        entry.names.push((element.propertyName ?? element.name).text);
      }
    }
    imports.push(entry);
  }
  return imports;
}

/** Reads name, directory and package.json of every package in packages/. */
export function loadWorkspacePackages(repoRoot) {
  const packagesDir = join(repoRoot, "packages");
  const packages = new Map();
  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(packagesDir, entry.name);
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    packages.set(manifest.name, { dir, manifest });
  }
  return packages;
}

/** Splits `@scope/name/sub/path` into the package name and the subpath. */
export function splitSpecifier(specifier) {
  const parts = specifier.split("/");
  const nameLength = specifier.startsWith("@") ? 2 : 1;
  const name = parts.slice(0, nameLength).join("/");
  const rest = parts.slice(nameLength).join("/");
  return { name, subpath: rest ? `./${rest}` : "." };
}

/** True for specifiers this check is responsible for. */
export function isWorkspaceSpecifier(specifier, packages) {
  const { name } = splitSpecifier(specifier);
  return (
    packages.has(name) ||
    name.startsWith("@authhero/") ||
    name === "authhero" ||
    name === "create-authhero"
  );
}

/**
 * Suggests the package a mistyped name most likely meant: `@authhero/kysely`
 * → `@authhero/kysely-adapter`, `@authhero/authhero` → `authhero`.
 */
export function suggestPackage(name, packages) {
  const names = [...packages.keys()];
  return (
    names.find((candidate) => candidate.startsWith(`${name}-`)) ??
    names.find((candidate) => name.endsWith(`/${candidate}`))
  );
}

function pickTypesTarget(target) {
  if (typeof target === "string") return target;
  if (!target || typeof target !== "object") return undefined;
  for (const condition of ["types", "import", "default", "require"]) {
    if (condition in target) {
      const found = pickTypesTarget(target[condition]);
      if (found) return found;
    }
  }
  return undefined;
}

function toDeclarationPath(dir, target) {
  const absolute = resolve(dir, target);
  if (/\.(d\.[cm]?ts|[cm]?tsx?)$/.test(absolute)) return absolute;
  const candidate = absolute.replace(/\.[cm]?js$/, ".d.ts");
  return candidate === absolute ? undefined : candidate;
}

/**
 * Resolves `specifier` to the type declaration file that describes it.
 *
 * Returns `{ error }` when the package or subpath doesn't exist, or
 * `{ typesFile }` (possibly undefined, for an export without types such as a
 * stylesheet).
 */
export function resolveSpecifier(specifier, packages) {
  const { name, subpath } = splitSpecifier(specifier);
  const pkg = packages.get(name);
  if (!pkg) {
    const suggestion = suggestPackage(name, packages);
    return {
      error: suggestion
        ? `"${name}" is not a package in this repository — did you mean "${suggestion}"?`
        : `"${name}" is not a package in this repository`,
    };
  }
  const { dir, manifest } = pkg;
  const exportsField = manifest.exports;

  if (exportsField === undefined) {
    if (subpath !== ".") return { typesFile: undefined };
    const types = manifest.types ?? manifest.typings;
    return { typesFile: types ? resolve(dir, types) : undefined };
  }

  const map =
    typeof exportsField === "string" ||
    Object.keys(exportsField).every((key) => !key.startsWith("."))
      ? { ".": exportsField }
      : exportsField;

  if (!(subpath in map)) {
    const available = Object.keys(map)
      .map((key) => (key === "." ? name : `${name}/${key.slice(2)}`))
      .join(", ");
    return {
      error: `"${specifier}" is not exported by ${name} (exports: ${available})`,
    };
  }

  let target = pickTypesTarget(map[subpath]);
  if (
    subpath === "." &&
    (typeof map["."] === "string" || !target || !/\.d\.[cm]?ts$/.test(target))
  ) {
    target = manifest.types ?? manifest.typings ?? target;
  }
  return { typesFile: target ? toDeclarationPath(dir, target) : undefined };
}

/**
 * Builds a function that returns the exported names of a declaration file,
 * using one TypeScript program for all of them.
 */
export function createExportReader(typesFiles) {
  const program = ts.createProgram({
    rootNames: [...typesFiles],
    options: {
      noEmit: true,
      skipLibCheck: true,
      allowJs: false,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: [],
    },
  });
  const checker = program.getTypeChecker();
  const cache = new Map();
  return (typesFile) => {
    if (cache.has(typesFile)) return cache.get(typesFile);
    const source = program.getSourceFile(typesFile);
    const symbol = source && checker.getSymbolAtLocation(source);
    const names = new Set(
      symbol ? checker.getExportsOfModule(symbol).map((s) => s.name) : [],
    );
    cache.set(typesFile, names);
    return names;
  };
}

/** Lists the Markdown files of the docs site that this check reads. */
export function listMarkdownFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".vitepress") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) files.push(...listMarkdownFiles(path));
    } else if (entry.name.endsWith(".md") && !SKIPPED_FILES.has(entry.name)) {
      files.push(path);
    }
  }
  return files.sort();
}

/**
 * Checks every Markdown file in `docsDir` and returns the problems found as
 * `{ file, line, message }`.
 */
export function checkDocs({ repoRoot, docsDir }) {
  const packages = loadWorkspacePackages(repoRoot);
  const samples = [];
  for (const file of listMarkdownFiles(docsDir)) {
    const markdown = readFileSync(file, "utf8");
    for (const block of extractCodeBlocks(markdown)) {
      if (block.ignored || !Object.hasOwn(SCRIPT_KINDS, block.lang)) continue;
      for (const entry of extractImports(block.code, block.lang)) {
        if (!isWorkspaceSpecifier(entry.specifier, packages)) continue;
        samples.push({ file, line: block.line + entry.line, entry });
      }
    }
  }

  const problems = [];
  const resolved = [];
  const typesFiles = new Set();
  const missingBuilds = new Set();
  for (const sample of samples) {
    const result = resolveSpecifier(sample.entry.specifier, packages);
    if (result.error) {
      problems.push({ ...sample, message: result.error });
      continue;
    }
    const wantsNames = sample.entry.defaultImport || sample.entry.names.length;
    if (!wantsNames) continue;
    if (!result.typesFile) {
      problems.push({
        ...sample,
        message: `"${sample.entry.specifier}" has no type declarations to import names from`,
      });
      continue;
    }
    if (!existsSync(result.typesFile)) {
      missingBuilds.add(relative(repoRoot, result.typesFile));
      continue;
    }
    typesFiles.add(result.typesFile);
    resolved.push({ ...sample, typesFile: result.typesFile });
  }

  if (missingBuilds.size > 0) {
    throw new Error(
      `Type declarations are missing — build the packages first ` +
        `(pnpm -r --filter './packages/**' build):\n  ` +
        [...missingBuilds].sort().join("\n  "),
    );
  }

  const readExports = createExportReader(typesFiles);
  for (const sample of resolved) {
    const exported = readExports(sample.typesFile);
    const { specifier, defaultImport, names } = sample.entry;
    if (defaultImport && !exported.has("default")) {
      problems.push({
        ...sample,
        message: `"${specifier}" has no default export`,
      });
    }
    for (const name of names) {
      if (!exported.has(name)) {
        problems.push({
          ...sample,
          message: `"${specifier}" does not export "${name}"`,
        });
      }
    }
  }

  return problems.map(({ file, line, message }) => ({
    file: relative(repoRoot, file),
    line,
    message,
  }));
}

function main() {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const docsDir = resolve(process.argv[2] ?? join(repoRoot, "apps/docs"));

  let problems;
  try {
    problems = checkDocs({ repoRoot, docsDir });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }

  for (const { file, line, message } of problems) {
    if (process.env.GITHUB_ACTIONS) {
      console.log(`::error file=${file},line=${line}::${message}`);
    }
    console.error(`${file}:${line}: ${message}`);
  }
  if (problems.length > 0) {
    console.error(
      `\n${problems.length} broken import(s) in docs code samples. ` +
        `Fix the sample, or mark a deliberately outdated one with ${IGNORE_MARKER}.`,
    );
    process.exit(1);
  }
  console.log("docs imports: all code-sample imports resolve.");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
