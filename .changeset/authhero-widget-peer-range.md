---
"authhero": patch
---

Fix the `@authhero/widget` peer dependency range. It was `^0.1.0`, a version that has never been published, so installing `authhero` with npm failed with `ETARGET` whenever the optional widget peer was resolved (for example in `create-authhero` Cloudflare scaffolds). The range is now `>=0.38.9`, the first widget release that exports `@authhero/widget/page-chrome`, which authhero imports.
