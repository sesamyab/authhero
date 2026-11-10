---
"@authhero/drizzle": patch
---

The build now emits `dist/drizzle-adapter.d.ts`. The package declared it as its `types` entry but did not produce it, so TypeScript consumers got no types for the adapter.
