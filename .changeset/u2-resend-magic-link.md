---
"authhero": patch
"@authhero/widget": patch
---

Fix resend on /u2: the widget's resend button now POSTs `{ data: { action: "resend" } }` to the screen API and renders the returned screen, and email-otp-challenge, sms-otp-challenge and magic-link-sent re-send the login code or link. `magic-link-sent` is now a registered screen at `/u2/login/magic-link-sent`, so reloading it no longer returns 400.

Login OTP delivery (identifier step plus resends) is capped at 5 per login session and consumes the optional per-recipient rate limit; past either limit the screens respond as usual but nothing is sent.
