---
"authhero": patch
---

Bind login and pre-signup codes to the address they were sent to. Codes now store their recipient and are only accepted for that address; a login session's earlier codes are retired when its username changes. Codes issued before this release carry no recipient and are no longer accepted: login codes have to be requested again, and a signup with an older pre-signup link continues unverified and sends a verification email.
