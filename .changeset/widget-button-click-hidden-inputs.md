---
"@authhero/widget": patch
---

Send the current value of hidden inputs when a submit button is clicked. The button click no longer passes the whole form-data snapshot as explicit overrides, so a hidden input updated by an inline script after render is submitted with its new value instead of the stale one.
