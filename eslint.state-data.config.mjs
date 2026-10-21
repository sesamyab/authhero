import tseslint from "typescript-eslint";
import { stateDataConfig } from "./tools/eslint/state-data.mjs";

// Run the ownership rule independently of the packages' existing lint backlog.
export default [
  {
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: false,
    },
  },
  {
    files: ["packages/authhero/src/**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser },
  },
  stateDataConfig,
];
