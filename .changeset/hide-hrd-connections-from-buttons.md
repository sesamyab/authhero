---
"authhero": patch
---

Hide HRD-only enterprise connections from the identifier screen's button row. Connections with `options.domain_aliases` configured are intended to be routed via email-domain matching (Home Realm Discovery), not shown as "Continue with X" buttons. The identifier screen now excludes any connection that has `domain_aliases` set, unless `show_as_button: true` is explicitly set on the connection. Matches Auth0's default behavior for enterprise connections.
