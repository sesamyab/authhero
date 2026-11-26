---
"authhero": patch
---

u2 change-email: the confirmation after entering the code is now shown without JavaScript too. A successful change redirects to the verify step, which renders the confirmation, instead of returning it from the POST, which the no-JS form post turned into a redirect back to the code form.
