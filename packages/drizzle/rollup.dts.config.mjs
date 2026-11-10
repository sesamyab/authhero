import dts from "rollup-plugin-dts";

export default {
  input: "./dist/types/src/index.d.ts",
  // One declaration file per runtime format, so NodeNext picks the one that
  // matches how the consumer loads the package.
  output: [
    { file: "./dist/drizzle-adapter.d.mts", format: "es" },
    { file: "./dist/drizzle-adapter.d.cts", format: "es" },
  ],
  external: (id) => !id.startsWith(".") && !id.startsWith("/"),
  plugins: [dts({ respectExternal: false })],
};
