<script setup lang="ts">
/**
 * The book's block on the docs landing page: a small cover, a pitch and the
 * two ways to read it.
 */
import { withBase } from "vitepress";
import parts from "../../book/chapters.json";

const chapterCount = parts.reduce((sum, part) => sum + part.chapters.length, 0);
</script>

<template>
  <aside class="book-promo">
    <a class="book-promo-cover" :href="withBase('/book/')" aria-hidden="true" tabindex="-1">
      <span class="book-promo-cover-mark">AuthHero</span>
      <span class="book-promo-cover-title">The<br />AuthHero<br />Book</span>
      <span class="book-promo-cover-foot">Authentication,<br />start to finish</span>
    </a>
    <div class="book-promo-body">
      <p class="book-promo-eyebrow">New to authentication, or to AuthHero?</p>
      <h2 class="book-promo-title">Read the AuthHero Book</h2>
      <p class="book-promo-text">
        A short book that starts with what a login is and ends with running
        AuthHero in production. It covers tokens, sessions, single sign-on,
        MFA, permissions, organizations, extensibility and multi-tenancy in
        {{ chapterCount }} chapters meant to be read in order.
      </p>
      <p class="book-promo-actions">
        <a class="book-promo-button book-promo-button-primary" :href="withBase('/book/')">
          Start reading
        </a>
        <a
          class="book-promo-button"
          :href="withBase('/authhero-book.pdf')"
          target="_blank"
          rel="noopener"
        >
          Download the PDF
        </a>
      </p>
    </div>
  </aside>
</template>

<style scoped>
.book-promo {
  display: flex;
  gap: 28px;
  align-items: center;
  margin: 28px 0 8px;
  padding: 24px 28px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 16px;
  background: var(--vp-c-bg-soft);
}

.book-promo-cover {
  display: flex;
  flex: none;
  flex-direction: column;
  justify-content: space-between;
  width: 132px;
  height: 180px;
  padding: 14px 14px 12px;
  border-radius: 4px 10px 10px 4px;
  border-left: 6px solid var(--ah-saffron);
  background: var(--ah-ink);
  box-shadow: 0 8px 20px rgba(24, 24, 27, 0.25);
  color: #fafafa;
  text-decoration: none;
  transition: transform 0.15s ease;
}

.book-promo-cover:hover {
  transform: translateY(-2px);
  color: #fafafa;
}

.book-promo-cover-mark {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ah-saffron);
}

.book-promo-cover-title {
  font-size: 22px;
  font-weight: 700;
  line-height: 1.05;
  letter-spacing: -0.03em;
}

.book-promo-cover-foot {
  font-size: 10px;
  line-height: 1.35;
  color: #a1a1aa;
}

.book-promo-eyebrow {
  margin: 0;
  font-size: 13px;
  line-height: 1.4;
  color: var(--vp-c-text-2);
}

.book-promo-title {
  margin: 2px 0 8px;
  padding: 0;
  border: none;
  font-size: 22px;
  line-height: 1.25;
}

.book-promo-text {
  margin: 0 0 14px;
  font-size: 15px;
  line-height: 1.6;
  color: var(--vp-c-text-2);
}

.book-promo-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 0;
}

.book-promo-button {
  display: inline-block;
  padding: 0 16px;
  border: 1px solid var(--vp-c-border);
  border-radius: 20px;
  font-size: 14px;
  font-weight: 600;
  line-height: 36px;
  color: var(--vp-c-text-1);
  text-decoration: none;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease;
}

.book-promo-button:hover {
  border-color: var(--vp-c-text-2);
  color: var(--vp-c-text-1);
}

.book-promo-button-primary {
  border-color: transparent;
  background: var(--ah-saffron);
  color: var(--ah-ink);
}

.book-promo-button-primary:hover {
  border-color: transparent;
  background: var(--ah-saffron-hover);
  color: var(--ah-ink);
}

@media (max-width: 560px) {
  .book-promo {
    flex-direction: column;
    align-items: flex-start;
    padding: 20px;
  }
}
</style>
