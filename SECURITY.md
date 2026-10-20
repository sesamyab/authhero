# Security Policy

## Supported versions

Only the latest major version of each published package receives security fixes. Older majors are not patched; upgrade to the current major to get fixes.

| Package                        | Supported |
| ------------------------------ | --------- |
| `authhero`                     | 9.x       |
| `@authhero/adapter-interfaces` | 4.x       |
| `@authhero/kysely-adapter`     | 12.x      |
| `@authhero/drizzle`            | 1.x       |
| `@authhero/aws-adapter`        | 1.x       |
| `@authhero/cloudflare-adapter` | 3.x       |
| `@authhero/saml`               | 0.x       |
| `@authhero/multi-tenancy`      | 15.x      |
| `@authhero/proxy`              | 0.x       |
| `@authhero/widget`             | 0.x       |
| `create-authhero`              | 0.x       |

Packages on 0.x are covered by the same rule: the latest 0.x release is the supported one.

## Reporting a vulnerability

Please do not open a public issue, discussion or pull request for a security problem.

Report it privately through GitHub's private vulnerability reporting:

**https://github.com/markusahlstrand/authhero/security/advisories/new**

Include what you need to reproduce the problem: the affected package and version, the steps or a proof of concept, and the impact you expect. We will confirm receipt, keep you informed while we investigate, and coordinate a fix and disclosure with you.
