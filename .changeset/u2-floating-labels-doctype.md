---
"authhero": patch
"@authhero/widget": patch
---

Fix the u2 page layout for forms taller than the screen and floating labels on textarea, URL and number fields.

- The u2 page, error page and token-info page now start with `<!DOCTYPE html>`. Without it they rendered in quirks mode, where the flex `<body>` was clamped to the viewport: a tall form (such as the self-service app registration) overflowed it, its top could not be scrolled to, there was no margin above or below the card, and the background image only covered the first screen.
- Textarea, URL and number fields now use the same floating label as other inputs, so the label moves out of the way instead of sitting on top of the typed text. A textarea's resting label sits on its first line instead of the vertical centre.
