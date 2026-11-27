# AuthHero Documentation

This is the VitePress-powered documentation site for AuthHero.

## Development

To start the development server:

```bash
npm run dev
```

To build the static site:

```bash
npm run build
```

To preview the built site:

```bash
npm run preview
```

## Structure

- `/index.md` - Homepage
- `/getting-started.md` - Getting started guide
- `/architecture.md` - Architecture overview
- `/concepts.md` - Core concepts
- `/session-management.md` - Session and login session architecture
- `/components/` - Component library documentation (with integrated Storybook)
- `/api/` - API documentation
- `/apps/` - Application documentation
- `/packages/` - Package documentation
- `/guides/` - User guides
- `/contributing/` - Contributing guidelines
- `/auth0-comparison/` - Auth0 comparison docs

## The AuthHero Book

`/book/` is a short book that explains authentication and AuthHero from start to finish. It is promoted on the homepage and is also published as a PDF.

- `book/chapters.json` is the one list of chapters, grouped into parts. The sidebar, the contents on `/book/` and the PDF all read it, so adding or reordering a chapter is a change there plus the chapter's markdown file.
- Each chapter is an ordinary page: `book/NN-slug.md`. Keep the "Chapter N · Part" line above the title in step with `chapters.json`.
- The PDF is `public/authhero-book.pdf`. Like the Storybook build, it is **committed**, so deploying the docs needs no browser.

After editing a chapter, rebuild the PDF and commit it:

```bash
pnpm --filter @authhero/docs book:pdf
```

This builds the site, opens every chapter in headless Chromium and prints them as one document with a cover and contents (see `scripts/build-book-pdf.mjs`). If Chromium is missing, install it once with `pnpm --filter @authhero/docs exec playwright-core install chromium`.

## Storybook Integration

The component library Storybook is integrated into the documentation site. The built Storybook files are **committed to the repository** in `public/storybook/` for deployment simplicity.

### Building Documentation Only

```bash
npm run build
```

This builds just the VitePress site (does not rebuild Storybook).

### Building Documentation + Storybook

```bash
npm run build:full
```

This rebuilds Storybook from `packages/authhero` and then builds VitePress.

### Developing with Storybook

To work on components with live reload:

```bash
# In packages/authhero directory
cd ../../packages/authhero
pnpm storybook
```

### When to Rebuild Storybook

Run `npm run build:full` when:
- Component stories are added or modified
- Component implementations change
- You want to update the Storybook in the docs

**Important:** After rebuilding Storybook, commit the changes in `public/storybook/` so they're deployed to production.

## Configuration

The VitePress configuration is in `.vitepress/config.ts`.
