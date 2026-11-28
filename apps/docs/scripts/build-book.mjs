/**
 * Builds the PDF and EPUB editions of the AuthHero Book.
 *
 *   pnpm --filter @authhero/docs book:build
 *
 * The chapters are ordinary docs pages, so both editions are made from the
 * built site rather than from the markdown: that way diagrams, code
 * highlighting and tables are the ones VitePress already rendered. The script
 * serves `.vitepress/dist`, opens every chapter in headless Chromium and lifts
 * the rendered article out of each page. For the PDF it stitches the chapters
 * into one document with a cover and a table of contents, and prints it. For
 * the EPUB it hands them to `book-epub.mjs`.
 *
 * Output: `public/authhero-book.pdf` and `public/authhero-book.epub`, which
 * are committed so the docs deploy needs no browser. Run this again after
 * editing a chapter.
 *
 * Needs a Chromium that matches playwright-core. If none is installed:
 *   pnpm --filter @authhero/docs exec playwright-core install chromium
 */
import { createServer } from "node:http";
import { copyFile, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { chapterFile, extractChapterXhtml, writeEpub } from "./book-epub.mjs";

const DOCS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(DOCS_ROOT, ".vitepress/dist");
const PDF_NAME = "authhero-book.pdf";
const EPUB_NAME = "authhero-book.epub";
const DOCS_ORIGIN = "https://docs.authhero.net";
const BLANK_PAGE = "/__book-blank";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

/** Serves the built site the way the host does: `/book/x` is `/book/x.html`. */
function serveDist() {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    // An empty page on the site's own origin, for the assembled book to be
    // written into: fonts only load for a same-origin document.
    if (path === BLANK_PAGE) {
      res.writeHead(200, { "content-type": MIME[".html"] });
      res.end("<!doctype html><title>The AuthHero Book</title>");
      return;
    }
    const base = normalize(join(DIST, path));
    if (!base.startsWith(DIST)) {
      res.writeHead(403).end();
      return;
    }
    for (const candidate of [base, `${base}.html`, join(base, "index.html")]) {
      const info = await stat(candidate).catch(() => undefined);
      if (!info?.isFile()) continue;
      res.writeHead(200, {
        "content-type": MIME[extname(candidate)] ?? "application/octet-stream",
      });
      res.end(await readFile(candidate));
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      done({ server, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

/**
 * Runs in the page. Returns the chapter's rendered article as an HTML string,
 * cleaned of the things that only make sense on the website.
 */
function extractChapter(prefix) {
  const article = document.querySelector("main .vp-doc > div");
  if (!article) throw new Error("no article on this page");
  const copy = article.cloneNode(true);

  // Permalink markers, copy buttons and language labels are website chrome.
  for (const el of copy.querySelectorAll(
    "a.header-anchor, button.copy, span.lang",
  )) {
    el.remove();
  }

  // Heading ids repeat between chapters ("contents", "passkeys"), and every
  // mermaid diagram styles itself through its own id. One document needs them
  // unique, so each id gets the chapter's prefix. A diagram's stylesheet and
  // marker references name the id too, so those are rewritten with it.
  for (const svg of copy.querySelectorAll("svg[id]")) {
    const id = svg.id;
    const scoped = `${prefix}-${id}`;
    svg.outerHTML = svg.outerHTML.split(id).join(scoped);
  }
  for (const el of copy.querySelectorAll("h1[id], h2[id], h3[id], h4[id]")) {
    el.id = `${prefix}-${el.id}`;
  }
  return copy.innerHTML;
}

const PRINT_CSS = `
  @page {
    size: A4;
    margin: 22mm 20mm 24mm;
    @bottom-center {
      content: counter(page);
      font: 500 9pt "Familjen Grotesk", system-ui, sans-serif;
      color: #71717a;
    }
    @top-right {
      content: "The AuthHero Book";
      font: 500 8pt "Familjen Grotesk", system-ui, sans-serif;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #a1a1aa;
    }
  }
  @page cover {
    margin: 0;
    @bottom-center { content: none; }
    @top-right { content: none; }
  }
  @page front {
    @top-right { content: none; }
  }

  html, body { margin: 0; padding: 0; background: #fff; }
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }

  .cover {
    page: cover;
    box-sizing: border-box;
    height: 297mm;
    padding: 30mm 24mm 24mm 30mm;
    border-left: 12mm solid #ffc93c;
    background: #18181b;
    color: #fafafa;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    break-after: page;
    font-family: "Familjen Grotesk", system-ui, sans-serif;
  }
  .cover-mark {
    font-size: 13pt; font-weight: 600; letter-spacing: 0.1em;
    text-transform: uppercase; color: #ffc93c;
  }
  .cover-title {
    margin: 0; font-size: 64pt; font-weight: 700; line-height: 1;
    letter-spacing: -0.035em;
  }
  .cover-subtitle {
    margin: 10mm 0 0; max-width: 120mm; font-size: 17pt; line-height: 1.35;
    color: #d4d4d8;
  }
  .cover-foot { font-size: 10pt; line-height: 1.6; color: #a1a1aa; }
  .cover-foot a { color: #fafafa; text-decoration: none; }

  .front { page: front; break-after: page; }
  .vp-doc .toc-part {
    margin: 8mm 0 2mm; font-size: 9pt; font-weight: 600; line-height: 1.5;
    letter-spacing: 0.06em; text-transform: uppercase; color: #71717a;
    break-after: avoid;
  }
  .toc-row {
    display: grid; grid-template-columns: 9mm 1fr; padding: 2.2mm 0;
    border-top: 1px solid #e4e4e7; break-inside: avoid;
  }
  .toc-number { font-family: "JetBrains Mono", monospace; font-size: 9pt; color: #71717a; line-height: 1.9; }
  .vp-doc .toc-row a { font-weight: 600; text-decoration: none; }
  .toc-blurb { display: block; font-size: 10pt; line-height: 1.45; color: #52525b; }

  .chapter { break-before: page; }
  /* The site's type is set for a screen; paper wants it a little tighter. */
  .vp-doc { font-size: 15px; }
  .vp-doc p, .vp-doc li, .vp-doc summary { line-height: 1.6; }
  .vp-doc p { margin: 12px 0; }
  .vp-doc h1 { margin-bottom: 8mm; }
  .vp-doc h2 { margin-top: 11mm; padding-top: 5mm; }
  .vp-doc h2, .vp-doc h3 { break-after: avoid; }
  .vp-doc p, .vp-doc li { orphans: 3; widows: 3; }
  .vp-doc tr, .vp-doc div[class*="language-"], .vp-doc .mermaid, .vp-doc svg {
    break-inside: avoid;
  }
  /* Tables on the site scroll sideways; on paper they have to fit. */
  .vp-doc table { display: table; width: 100%; font-size: 0.9em; }
  .vp-doc th, .vp-doc td { overflow-wrap: break-word; }
  .vp-doc div[class*="language-"] { margin: 16px 0; border-radius: 8px; }
  .vp-doc div[class*="language-"] pre { overflow: visible; }
  .vp-doc div[class*="language-"] code { white-space: pre-wrap; overflow-wrap: anywhere; }
  .vp-doc .mermaid { text-align: center; }
  .vp-doc .mermaid svg { max-width: 100%; height: auto; }
`;

const COVER_IMAGE_CSS = `
  .cover {
    width: 800px; height: 1280px; padding: 120px 80px 90px 100px;
    border-left-width: 44px;
  }
`;

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function main() {
  if (!existsSync(join(DIST, "book/index.html"))) {
    throw new Error(
      "No built site in .vitepress/dist. Run `vitepress build` first (the book:build script does).",
    );
  }

  const parts = JSON.parse(
    await readFile(join(DOCS_ROOT, "book/chapters.json"), "utf8"),
  );
  let n = 0;
  const chapters = parts.flatMap((part) =>
    part.chapters.map((chapter) => ({
      ...chapter,
      part: part.part,
      number: ++n,
      id: `chapter-${n}`,
    })),
  );

  const { server, origin } = await serveDist();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
      // Diagrams are photographed for the EPUB; twice the pixels keeps their
      // text sharp when a reader scales them up.
      deviceScaleFactor: 2,
      colorScheme: "light",
    });
    const chapterFiles = Object.fromEntries(
      chapters.map((chapter) => [
        `/book/${chapter.slug}`,
        chapterFile(chapter.number),
      ]),
    );

    let stylesheets = [];
    for (const chapter of chapters) {
      await page.goto(`${origin}/book/${chapter.slug}`, {
        waitUntil: "networkidle",
      });
      // Diagrams are drawn in the browser after the page mounts.
      await page.waitForFunction(() =>
        [...document.querySelectorAll(".mermaid")].every((el) =>
          el.querySelector("svg"),
        ),
      );
      chapter.html = await page.evaluate(extractChapter, chapter.id);

      const diagrams = page.locator("main .vp-doc .mermaid svg");
      chapter.images = [];
      for (let i = 0; i < (await diagrams.count()); i++) {
        chapter.images.push({
          name: `images/${chapter.id}-${i + 1}.png`,
          data: await diagrams.nth(i).screenshot(),
        });
      }
      chapter.xhtml = await page.evaluate(extractChapterXhtml, {
        images: chapter.images.map((image) => image.name),
        chapterFiles,
        docsOrigin: DOCS_ORIGIN,
      });
      if (!stylesheets.length) {
        stylesheets = await page.evaluate(() =>
          [...document.querySelectorAll('link[rel~="stylesheet"]')].map(
            (link) => link.href,
          ),
        );
      }
      console.log(`  ${String(chapter.number).padStart(2)}. ${chapter.title}`);
    }

    const toc = parts
      .map((part) => {
        const rows = chapters
          .filter((chapter) => chapter.part === part.part)
          .map(
            (chapter) => `
              <div class="toc-row">
                <span class="toc-number">${chapter.number}</span>
                <span>
                  <a href="#${chapter.id}">${escapeHtml(chapter.title)}</a>
                  <span class="toc-blurb">${escapeHtml(chapter.blurb)}</span>
                </span>
              </div>`,
          )
          .join("");
        return `<p class="toc-part">${escapeHtml(part.part)}</p>${rows}`;
      })
      .join("");

    const edition = new Intl.DateTimeFormat("en", {
      month: "long",
      year: "numeric",
    }).format(new Date());

    const styles = stylesheets
      .map((href) => `<link rel="stylesheet" href="${href}" />`)
      .join("");
    const cover = `
          <section class="cover">
            <div class="cover-mark">AuthHero</div>
            <div>
              <p class="cover-title">The<br />AuthHero<br />Book</p>
              <p class="cover-subtitle">
                Authentication from first principles, and how AuthHero handles it.
              </p>
            </div>
            <div class="cover-foot">
              ${edition} edition<br />
              Read online at <a href="${DOCS_ORIGIN}/book/">docs.authhero.net/book</a>
            </div>
          </section>`;

    const html = `<!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <title>The AuthHero Book</title>
          <meta name="author" content="AuthHero" />
          ${styles}
          <style>${PRINT_CSS}</style>
        </head>
        <body>
          ${cover}
          <section class="front vp-doc">
            <h1>Contents</h1>
            ${toc}
          </section>
          ${chapters
            .map(
              (chapter) =>
                `<section class="chapter vp-doc" id="${chapter.id}">${chapter.html}</section>`,
            )
            .join("")}
        </body>
      </html>`;

    await page.goto(`${origin}${BLANK_PAGE}`);
    await page.setContent(html, { waitUntil: "networkidle" });

    // Links between chapters jump inside the PDF; every other site link has to
    // leave it, so it points at the published docs.
    await page.evaluate(
      ({ docsOrigin, slugs }) => {
        for (const link of document.querySelectorAll("a[href]")) {
          const href = link.getAttribute("href");
          if (!href.startsWith("/")) continue;
          const [path, hash] = href.split("#");
          const chapter = slugs[path.replace(/\/$/, "")];
          if (chapter) link.setAttribute("href", `#${chapter}`);
          else
            link.setAttribute(
              "href",
              `${docsOrigin}${path}${hash ? `#${hash}` : ""}`,
            );
        }
      },
      {
        docsOrigin: DOCS_ORIGIN,
        slugs: Object.fromEntries(
          chapters.map((chapter) => [`/book/${chapter.slug}`, chapter.id]),
        ),
      },
    );
    await page.evaluate(() => document.fonts.ready);

    await page.pdf({
      path: join(DOCS_ROOT, "public", PDF_NAME),
      preferCSSPageSize: true,
      printBackground: true,
      outline: true,
      tagged: true,
    });

    // The EPUB's cover is the same cover, photographed at a book's proportions.
    await page.setViewportSize({ width: 800, height: 1280 });
    await page.setContent(
      `<!doctype html><html lang="en"><head><meta charset="utf-8" />${styles}
        <style>${PRINT_CSS}${COVER_IMAGE_CSS}</style></head><body>${cover}</body></html>`,
      { waitUntil: "networkidle" },
    );
    await page.evaluate(() => document.fonts.ready);
    const coverPng = await page.locator(".cover").screenshot();

    await writeEpub({
      parts,
      chapters,
      coverPng,
      output: join(DOCS_ROOT, "public", EPUB_NAME),
      docsOrigin: DOCS_ORIGIN,
    });
  } finally {
    await browser.close();
    server.close();
  }

  // The site was built before these files existed, so the build has no copy.
  for (const name of [PDF_NAME, EPUB_NAME]) {
    await copyFile(join(DOCS_ROOT, "public", name), join(DIST, name));
    const { size } = await stat(join(DOCS_ROOT, "public", name));
    console.log(`Wrote public/${name} (${(size / 1024 / 1024).toFixed(1)} MB)`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
