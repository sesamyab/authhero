import globals from "globals";
import pluginJs from "@eslint/js";
import tseslint from "typescript-eslint";
import pluginReactConfig from "eslint-plugin-react/configs/recommended.js";
import { fixupConfigRules } from "@eslint/compat";
import { createRequire } from "node:module";

// eslint-plugin-react-hooks is a dependency of apps/admin only, so resolve
// it from there rather than from the workspace root.
const requireFromAdmin = createRequire(
  new URL("./apps/admin/package.json", import.meta.url),
);
const reactHooks = requireFromAdmin("eslint-plugin-react-hooks");

export default [
  { files: ["**/*.{js,mjs,cjs,ts,jsx,tsx}"] },
  { languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } } },
  { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  pluginJs.configs.recommended,
  ...tseslint.configs.recommended,
  ...fixupConfigRules(pluginReactConfig),
  {
    settings: {
      react: {
        version: "detect", // Automatically detect the react version
      },
    },
    rules: {
      "react/react-in-jsx-scope": "off", // Turn off the rule for requiring React in scope
      // `_`-prefixed bindings and rest-sibling destructuring are the
      // codebase's idiom for intentionally-discarded values.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // `ctx.env` is one object shared by every request in a Workers isolate,
    // so per-request state written to it leaks between requests (#140). Put
    // it on a context variable instead; the adapter stack goes through
    // `setRequestData`. These two files are the only sanctioned writers.
    files: [
      "packages/authhero/src/**/*.{ts,tsx}",
      "packages/multi-tenancy/src/**/*.{ts,tsx}",
    ],
    ignores: [
      "packages/authhero/src/helpers/request-data.ts",
      "packages/authhero/src/middlewares/apply-config.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "AssignmentExpression > MemberExpression.left[object.type='MemberExpression'][object.property.name='env']",
          message:
            "Don't write to ctx.env during a request (#140). Use a context variable (ctx.set), or setRequestData for the adapter stack.",
        },
        {
          selector:
            "AssignmentExpression > MemberExpression.left[property.name='env']",
          message:
            "Don't replace ctx.env during a request (#140); only applyConfigMiddleware may copy it.",
        },
      ],
    },
  },
  {
    // apps/admin is a typed React codebase: PropTypes are redundant, and the
    // react-admin data layer is deliberately loosely typed, so `any` is
    // reported as a warning (cleanup backlog) instead of failing CI.
    files: ["apps/admin/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react/prop-types": "off",
      "react/no-unescaped-entities": "off",
      "react-hooks/exhaustive-deps": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
];
