import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import DocsMap from "./DocsMap.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("DocsMap", DocsMap);
  },
} satisfies Theme;
