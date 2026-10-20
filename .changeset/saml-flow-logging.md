---
"authhero": patch
"@authhero/adapter-interfaces": patch
---

Log the SAML IdP flow: the `/samlp/:client_id` entry, assertion issuance (client, NameID and its source, audience, destination, signing `kid`, `inResponseTo`) and every failure path in `samlCallback`. Log entries can now carry `details.login_session_id` so a single login flow can be traced. `logMessage` now defaults `login_session_id` to the request's login session, so `/authorize`, `/u/*` and the post-login `SUCCESS_LOGIN` entries carry it too.
