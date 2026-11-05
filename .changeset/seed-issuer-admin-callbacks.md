---
"authhero": minor
---

`seed()` now allows the issuer's own origin on the default client when `issuer` is passed: `<origin>/auth-callback` and `<origin>/admin/auth-callback` as callbacks, the origin and `<origin>/admin` as logout URLs, and the origin as a web origin. Without it the admin UI served from a deployed host stopped at "redirect_uri not allowed". Explicit `callbacks` / `allowedLogoutUrls` still win and the fixed defaults are kept. Only a client that `seed()` creates gets the new URLs: when the default client already exists it is left as it is, so an existing tenant has to add them to its client itself.
