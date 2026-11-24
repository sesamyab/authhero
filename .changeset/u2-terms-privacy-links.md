---
"@authhero/adapter-interfaces": minor
"@authhero/drizzle": minor
"@authhero/kysely-adapter": minor
"@authhero/aws-adapter": minor
"@authhero/widget": minor
"authhero": minor
"@authhero/admin": minor
---

Separate terms and privacy links on the universal login page (#1735, part of #1508). A client's `client_metadata.tos_uri` and `policy_uri` (the DCR names) are now rendered as individual "Terms" and "Privacy Policy" links in the page chip and the phone footer. New optional `branding.terms_url` and `branding.privacy_url` act as tenant-wide defaults for clients that set neither. The existing `client_metadata.termsAndConditionsUrl` keeps working as the terms fallback, so existing tenants render exactly as before. The kysely adapter gets a migration (two nullable `branding` columns), drizzle ships `0025_branding_legal_links.sql`, DynamoDB stores the two strings. The admin gets "Terms of service URL" / "Privacy policy URL" fields on the client Details tab and a "Legal links" section on the Branding tab.
