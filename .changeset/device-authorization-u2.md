---
"authhero": minor
"@authhero/adapter-interfaces": minor
"@authhero/kysely-adapter": minor
"@authhero/drizzle": minor
"@authhero/aws-adapter": minor
---

Support OAuth 2.0 Device Authorization Grant (RFC 8628) with u2 code entry, normal login and MFA, explicit approval or denial, and single-use token exchange. Add hashed device-code storage, atomic polling backoff, activation attempt limits, SQL migrations and DynamoDB TTL support, discovery metadata, and the Device Code grant option in the admin UI.

Optionally return an SVG QR-code image for the complete verification URL, and add independent QR decoding plus browser-level RFC 8628 checks to the conformance runner.
