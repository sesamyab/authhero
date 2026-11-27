import path from "path";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    outDir: "./dist",
    emptyOutDir: false,
    lib: {
      entry: {
        "local-signer": path.resolve(__dirname, "src/local-signer.ts"),
        "local-verifier": path.resolve(__dirname, "src/local-verifier.ts"),
      },
      formats: ["es", "cjs"],
      fileName: (format, entryName) =>
        `${entryName}.${format === "es" ? "mjs" : "cjs"}`,
    },
    rollupOptions: {
      external: ["xml-crypto", "@xmldom/xmldom"],
    },
  },
  resolve: {
    alias: [
      { find: "@", replacement: path.resolve(__dirname, "src") },
      { find: "@@", replacement: path.resolve(__dirname) },
    ],
  },
});
