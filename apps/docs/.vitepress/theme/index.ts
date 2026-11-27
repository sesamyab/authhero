import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import BookContents from "./BookContents.vue";
import BookPromo from "./BookPromo.vue";
import DocsMap from "./DocsMap.vue";
import "./custom.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("BookContents", BookContents);
    app.component("BookPromo", BookPromo);
    app.component("DocsMap", DocsMap);
  },
} satisfies Theme;
