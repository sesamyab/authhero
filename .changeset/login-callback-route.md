---
"authhero": minor
"@authhero/adapter-interfaces": minor
---

Add `/login/callback` as the new path for the upstream connection callback. The existing `/callback` route continues to work but is now marked as deprecated in the OpenAPI spec.

Connections can also override the redirect_uri sent to the upstream IdP via the new `options.callback_url` field. When set, the strategy uses that URL verbatim; when unset, it falls back to the legacy `${authUrl}callback`. This lets operators flip individual connections to `/login/callback` (or any other registered redirect URI) one at a time as they update each IdP's allowed redirect URIs — no big-bang migration required.
