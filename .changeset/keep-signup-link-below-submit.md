---
"@authhero/widget": patch
"@authhero/admin": patch
---

Match Auth0's prompt partial layout. When a screen has prompt partials, the bottom links (such as the sign-up link) now render between `form-footer-start` and `form-footer-end`, below the submit button, and `secondary-actions-start`/`-end` wrap the social login buttons. Adding a partial no longer moves the sign-up link above the submit button. Screens without partials render as before.

The admin partials editor shows every insertion point in the preview as a labelled placeholder, and its zone descriptions now match where they render.
