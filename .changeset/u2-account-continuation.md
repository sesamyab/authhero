---
"authhero": minor
---

The form-hook `account` redirect target now sends users to `/u2/account` instead of `/u/account`. The u2 account hub works mid-login: while the login session awaits a continuation with the `account` scope, it shows the user without needing a session cookie, offers a change-email entry and a Continue button that resumes the login. The hub's other sections and the logout link are only shown to signed-in users. Change-email opened from the hub mid-login returns to the hub when done.

A continuation (the scope a form hook grants to account, change-email or passkey pages mid-login) now ends when its login session expires, on both `/u2` and `/u`; an expired one sends the user to log in.
