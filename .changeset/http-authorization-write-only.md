---
"authhero": minor
"@authhero/admin": minor
---

Make a log stream's `http_authorization` write-only, like the Firehose `aws_secret_access_key`. The management API no longer returns it (including Auth0's camelCase `httpAuthorization`) from list, get, create or update. A sink update that omits it or sends an empty string keeps the stored header, a new value replaces it, and `null` removes it. Stored credentials are only carried over when the stream keeps its type. API clients that read `sink.http_authorization` back will no longer see it.

In the admin UI, the Authorization header field is now a password field. When editing, leave it blank to keep the current header, or use **Remove the stored Authorization header** to clear it.
