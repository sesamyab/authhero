---
"@authhero/adapter-interfaces": minor
"authhero": patch
"@authhero/admin": patch
---

Trim leading and trailing whitespace from provider-issued credentials (connection, client, resource-server and migration-source secrets, Twilio tokens, email-provider keys and log-stream sink keys) when they are written through the management API, and when connection secrets are used for upstream token calls. User-chosen values such as SMTP passwords and action secrets are stored as sent. The admin secret inputs now warn when a value starts or ends with whitespace.
