/**
 * The EPUB edition of the AuthHero Book.
 *
 * `build-book.mjs` visits every chapter in a browser and calls into this file
 * twice: `extractChapterXhtml` runs inside the page and turns the rendered
 * article into the XHTML an e-reader accepts, and `writeEpub` packs the
 * chapters, images, cover, table of contents and package file into the `.epub`.
 *
 * An EPUB is a zip file with a fixed layout, so there is no dependency here:
 * the container is written by hand at the bottom of this file.
 */
import { deflateRawSync, crc32 } from "node:zlib";
import { writeFile } from "node:fs/promises";

const TITLE = "The AuthHero Book";
const SUBTITLE =
  "Authentication from first principles, and how AuthHero handles it.";
// Stays the same across builds: it is what tells a reading app that a new
// download is a new edition of the same book, not a different book.
const BOOK_ID = "urn:uuid:6f1d0c2e-8a57-4b0e-9c3a-2b7e5d41a9f3";

/** The file a chapter becomes inside the EPUB. */
export function chapterFile(number) {
  return `chapter-${String(number).padStart(2, "0")}.xhtml`;
}

/**
 * Runs in the page. Returns the chapter's article as an XHTML fragment.
 *
 * E-readers are far stricter and far less capable than a browser, so the
 * article is rebuilt rather than copied: diagrams become the images taken of
 * them, syntax colours become plain inline colours, links point at files in the
 * book or at the published docs, and every attribute a reader could choke on is
 * dropped.
 */
export function extractChapterXhtml({ images, chapterFiles, docsOrigin }) {
  const article = document.querySelector("main .vp-doc > div");
  if (!article) throw new Error("no article on this page");
  const copy = article.cloneNode(true);

  // Highlighted code is coloured through CSS variables that a reader does not
  // have. The live page knows what each one resolves to.
  const liveSpans = article.querySelectorAll("pre span[style]");
  const copySpans = copy.querySelectorAll("pre span[style]");
  const colors = new Map();
  liveSpans.forEach((span, i) => {
    colors.set(copySpans[i], getComputedStyle(span).color);
  });

  // Diagrams are SVG with HTML inside, which most readers cannot draw, so each
  // one is replaced by its screenshot. The description written into the
  // diagram source becomes the image's alternative text.
  const liveDiagrams = article.querySelectorAll(".mermaid");
  copy.querySelectorAll(".mermaid").forEach((node, i) => {
    const svg = liveDiagrams[i].querySelector("svg");
    const alt =
      svg?.querySelector("desc")?.textContent?.trim() ||
      svg?.querySelector("title")?.textContent?.trim() ||
      "Diagram";
    const figure = document.createElement("figure");
    const img = document.createElement("img");
    img.setAttribute("src", images[i]);
    img.setAttribute("alt", alt);
    figure.append(img);
    node.replaceWith(figure);
  });

  for (const el of copy.querySelectorAll(
    "a.header-anchor, button.copy, span.lang",
  )) {
    el.remove();
  }

  for (const link of copy.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href");
    if (!href.startsWith("/")) continue;
    const [path, hash] = href.split("#");
    const file = chapterFiles[path.replace(/\/$/, "")];
    link.setAttribute(
      "href",
      file ?? `${docsOrigin}${path}${hash ? `#${hash}` : ""}`,
    );
  }

  const kept = new Set(["href", "src", "alt", "colspan", "rowspan"]);
  for (const el of copy.querySelectorAll("*")) {
    const kicker = el.classList.contains("book-kicker");
    for (const name of el.getAttributeNames()) {
      if (!kept.has(name)) el.removeAttribute(name);
    }
    if (kicker) el.setAttribute("class", "book-kicker");
    const color = colors.get(el);
    if (color) el.setAttribute("style", `color: ${color}`);
  }

  const serializer = new XMLSerializer();
  return [...copy.childNodes]
    .map((node) => serializer.serializeToString(node))
    .join("");
}

const STYLESHEET = `
body { margin: 0 5%; line-height: 1.55; }
h1 { margin: 0.2em 0 1em; font-size: 1.8em; line-height: 1.2; }
h2 { margin: 1.8em 0 0.6em; font-size: 1.3em; line-height: 1.25; }
h3 { margin: 1.4em 0 0.5em; font-size: 1.1em; }
h1, h2, h3 { page-break-after: avoid; }
p { margin: 0.7em 0; }
a { color: inherit; }
.book-kicker {
  margin: 1.5em 0 0; font-size: 0.75em; font-weight: bold;
  letter-spacing: 0.06em; text-transform: uppercase; color: #71717a;
}
table { width: 100%; margin: 1em 0; border-collapse: collapse; font-size: 0.9em; }
th, td { padding: 0.4em 0.6em; border: 1px solid #d4d4d8; text-align: left; vertical-align: top; }
th { background: #f4f4f5; }
code { font-family: monospace; font-size: 0.9em; }
pre {
  margin: 1em 0; padding: 0.8em; border-radius: 6px; background: #f5f5f4;
  font-size: 0.85em; line-height: 1.45; white-space: pre-wrap; overflow-wrap: break-word;
}
pre code { font-size: 1em; }
figure { margin: 1.2em 0; text-align: center; page-break-inside: avoid; }
img { max-width: 100%; height: auto; }
.cover { margin: 0; padding: 0; text-align: center; }
.cover img { max-width: 100%; max-height: 100%; }
nav ol { padding-left: 1.2em; }
nav li { margin: 0.3em 0; }
nav > ol { list-style: none; padding-left: 0; }
nav > ol > li > span { font-size: 0.8em; font-weight: bold; letter-spacing: 0.06em; text-transform: uppercase; color: #71717a; }
.colophon { margin-top: 2.5em; font-size: 0.85em; color: #71717a; }
`;

function escapeXml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(title, body, bodyAttributes = "") {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeXml(title)}</title>
<link rel="stylesheet" type="text/css" href="book.css" />
</head>
<body${bodyAttributes}>
${body}
</body>
</html>
`;
}

/**
 * Writes the book to `output`.
 *
 * `chapters` carry `number`, `title`, `part`, `xhtml` and `images`
 * (`{ name, data }`, PNG); `coverPng` is the cover as a PNG buffer.
 */
export async function writeEpub({
  parts,
  chapters,
  coverPng,
  output,
  docsOrigin,
}) {
  const modified = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  const contents = parts
    .map((part) => {
      const items = chapters
        .filter((chapter) => chapter.part === part.part)
        .map(
          (chapter) =>
            `<li><a href="${chapterFile(chapter.number)}">${chapter.number}. ${escapeXml(chapter.title)}</a></li>`,
        )
        .join("\n");
      return `<li><span>${escapeXml(part.part)}</span>\n<ol>\n${items}\n</ol>\n</li>`;
    })
    .join("\n");

  const nav = page(
    "Contents",
    `<nav epub:type="toc" id="toc">
<h1>Contents</h1>
<ol>
${contents}
</ol>
</nav>
<p class="colophon">${escapeXml(SUBTITLE)} Read online at <a href="${docsOrigin}/book/">docs.authhero.net/book</a>.</p>`,
  );

  const ncx = `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="${BOOK_ID}" /></head>
<docTitle><text>${escapeXml(TITLE)}</text></docTitle>
<navMap>
${chapters
  .map(
    (chapter) =>
      `<navPoint id="nav-${chapter.number}" playOrder="${chapter.number}"><navLabel><text>${chapter.number}. ${escapeXml(chapter.title)}</text></navLabel><content src="${chapterFile(chapter.number)}" /></navPoint>`,
  )
  .join("\n")}
</navMap>
</ncx>
`;

  const images = chapters.flatMap((chapter) => chapter.images);
  const manifest = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />`,
    `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />`,
    `<item id="css" href="book.css" media-type="text/css" />`,
    `<item id="cover-image" href="images/cover.png" media-type="image/png" properties="cover-image" />`,
    `<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml" />`,
    ...chapters.map(
      (chapter) =>
        `<item id="chapter-${chapter.number}" href="${chapterFile(chapter.number)}" media-type="application/xhtml+xml" />`,
    ),
    ...images.map(
      (image, i) =>
        `<item id="image-${i + 1}" href="${image.name}" media-type="image/png" />`,
    ),
  ];

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="en">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="book-id">${BOOK_ID}</dc:identifier>
<dc:title>${escapeXml(TITLE)}</dc:title>
<dc:language>en</dc:language>
<dc:creator>AuthHero</dc:creator>
<dc:publisher>AuthHero</dc:publisher>
<dc:description>${escapeXml(SUBTITLE)}</dc:description>
<dc:source>${docsOrigin}/book/</dc:source>
<meta property="dcterms:modified">${modified}</meta>
<meta name="cover" content="cover-image" />
</metadata>
<manifest>
${manifest.join("\n")}
</manifest>
<spine toc="ncx">
<itemref idref="cover" />
<itemref idref="nav" />
${chapters.map((chapter) => `<itemref idref="chapter-${chapter.number}" />`).join("\n")}
</spine>
</package>
`;

  const container = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<rootfiles>
<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" />
</rootfiles>
</container>
`;

  const text = (name, content) => ({ name, data: Buffer.from(content) });
  const entries = [
    // The reader identifies the file by this entry: first, and uncompressed.
    { ...text("mimetype", "application/epub+zip"), store: true },
    text("META-INF/container.xml", container),
    text("OEBPS/content.opf", opf),
    text("OEBPS/nav.xhtml", nav),
    text("OEBPS/toc.ncx", ncx),
    text("OEBPS/book.css", STYLESHEET),
    text(
      "OEBPS/cover.xhtml",
      page(
        TITLE,
        `<img src="images/cover.png" alt="${escapeXml(`${TITLE}. ${SUBTITLE}`)}" />`,
        ' class="cover" epub:type="cover"',
      ),
    ),
    { name: "OEBPS/images/cover.png", data: coverPng, store: true },
    ...chapters.map((chapter) =>
      text(
        `OEBPS/${chapterFile(chapter.number)}`,
        page(
          `${chapter.number}. ${chapter.title}`,
          `<section epub:type="chapter">${chapter.xhtml}</section>`,
        ),
      ),
    ),
    ...images.map((image) => ({
      name: `OEBPS/${image.name}`,
      data: image.data,
      store: true,
    })),
  ];

  await writeFile(output, zip(entries));
}

/** A zip archive of `entries` (`{ name, data, store? }`). */
function zip(entries) {
  // A fixed timestamp, so rebuilding an unchanged book changes fewer bytes.
  const DOS_TIME = 0;
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const UTF8_NAMES = 0x0800;

  const local = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const body = entry.store ? entry.data : deflateRawSync(entry.data);
    const method = entry.store ? 0 : 8;
    const checksum = crc32(entry.data);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(UTF8_NAMES, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(entry.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, body);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(UTF8_NAMES, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt16LE(DOS_TIME, 12);
    record.writeUInt16LE(DOS_DATE, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(entry.data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);

    offset += header.length + name.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
