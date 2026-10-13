---
"authhero": patch
---

Run post-login hooks for SAML logins. The SAML response was built before `completeLogin`, so page and form hooks (such as the impersonate page), code hooks, webhooks and the success-login log were skipped for SAML. Also fix the u2 impersonate screen failing with "Failed to generate redirect" when the auth response is the SAML POST form rather than a redirect.

Page hooks (such as impersonate) now use the client the login is already running with to choose between `/u` and `/u2`, instead of looking the client up a second time and silently falling back to `/u` if that lookup failed.
