---
"@authhero/admin": patch
---

API errors without a JSON `message` show `HTTP <status>` when the response has no status text (HTTP/2), instead of an empty message.
