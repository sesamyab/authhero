<script setup lang="ts">
/**
 * The table of contents on the book's cover page.
 *
 * `book/chapters.json` is the one list of chapters: the sidebar, this page and
 * the PDF build all read it, so adding or reordering a chapter is a change in
 * one place.
 */
import { withBase } from "vitepress";
import parts from "../../book/chapters.json";

let n = 0;
const numbered = parts.map((part) => ({
  title: part.part,
  chapters: part.chapters.map((chapter) => ({
    ...chapter,
    number: ++n,
    href: withBase(`/book/${chapter.slug}`),
  })),
}));
</script>

<template>
  <div class="book-contents">
    <section v-for="part in numbered" :key="part.title">
      <h3>{{ part.title }}</h3>
      <ol>
        <li v-for="chapter in part.chapters" :key="chapter.slug">
          <span class="book-contents-number">{{ chapter.number }}</span>
          <span>
            <a :href="chapter.href">{{ chapter.title }}</a>
            <span class="book-contents-blurb">{{ chapter.blurb }}</span>
          </span>
        </li>
      </ol>
    </section>
  </div>
</template>

<style scoped>
.book-contents h3 {
  margin: 28px 0 8px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--vp-c-text-3);
}

.book-contents ol {
  margin: 0;
  padding: 0;
  list-style: none;
}

.book-contents li {
  display: grid;
  grid-template-columns: 2.25em 1fr;
  margin: 0;
  padding: 10px 0;
  border-top: 1px solid var(--vp-c-divider);
}

.book-contents-number {
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  line-height: 28px;
  color: var(--vp-c-text-3);
}

.book-contents a {
  font-weight: 600;
}

.book-contents-blurb {
  display: block;
  font-size: 14px;
  line-height: 1.5;
  color: var(--vp-c-text-2);
}
</style>
