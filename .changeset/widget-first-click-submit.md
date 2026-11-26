---
"@authhero/widget": patch
---

Fix the first click on the primary button (e.g. "Register" on `/u2/signup`) sometimes doing nothing. While required fields were missing the button carried a native `disabled` attribute, and Stencil only removes it on its next render; a click that landed before that render was swallowed by the browser. The required-field gate now renders `aria-disabled` and the click handler re-checks the live form state, so the first click submits as soon as every required field is filled. `disabled` is still used while a submit is in flight.
