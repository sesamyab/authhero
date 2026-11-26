---
"@authhero/adapter-interfaces": minor
"@authhero/widget": minor
"authhero": patch
---

Universal login v2 input types match /u (#1733):

- TEXT fields accept `input_mode` and `autocomplete` in their config, and PASSWORD fields accept `autocomplete` (`current-password` or `new-password`).
- u2 code fields ask for a numeric keypad and `one-time-code` autofill.
- Signup, password reset and invitation password fields are marked `new-password`, so password managers offer to generate one.
- The identifier field is only an email field when email is all it accepts; with an SMS connection it is a text field labelled for phone or email.
