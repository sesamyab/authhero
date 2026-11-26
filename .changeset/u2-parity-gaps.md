---
"authhero": minor
---

Universal login v2: close the remaining parity gaps with /u (#1733).

- New `/u2/error`, `/u2/invalid-session`, `/u2/account/change-email` and `/u2/account/change-email/verify`.
- Callback errors, the `/account` change-email deny, passwordless invalid-session redirects, form-hook `change-email` redirects and `screen_hint=change-email` now go to /u2.
- u2 signup redeems the code of pre-signup verification emails, and those emails now link to `/u2/signup`. Links already sent to `/u/signup` keep working.
- The code email's plain fallback shows the code instead of a `/u/validate-email` link that could never work.
- u2 change-email stores the new address with the code (it can't be swapped at the verify step), codes expire after 30 minutes and are rate limited, and an address being taken is only revealed after its code is entered.
- u2 login screens apply the same social button rules as /u: `show_as_button: false` hides a connection, home-realm-discovery connections stay hidden on the combined (password-first) login screen too, and Google is hidden in in-app browsers.
