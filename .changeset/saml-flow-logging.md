---
"authhero": patch
"@authhero/adapter-interfaces": patch
---

Log the SAML IdP flow: the `/samlp/:client_id` entry, assertion issuance (client, NameID and its source, audience, destination, signing `kid`, `inResponseTo`) and every failure path in `samlCallback`. Log entries can now carry `details.login_session_id` so a single login flow can be traced.
