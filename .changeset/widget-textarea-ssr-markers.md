---
"@authhero/widget": patch
---

Fix multiline text fields showing Stencil hydration markers (`<!--t.N-->`) as their content after server-side rendering. The textarea value is now set as a property instead of a child text node, and pre-filled values still render server-side.
