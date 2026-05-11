---
"authhero": patch
---

Universal login identifier page: accept an unknown email when the client is configured for Auth0 lazy migration (a `strategy: "auth0"` source plus a `Username-Password-Authentication` connection with `import_mode: true`), so the password step can verify against upstream Auth0 and migrate the user instead of failing identifier validation with "Email is not valid." Also hide HRD-enabled connections (those with `options.domain_aliases`) from the social/enterprise button row by default — they're reached via email-domain routing, matching Auth0's behavior. An explicit `show_as_button: true` opts back in.
