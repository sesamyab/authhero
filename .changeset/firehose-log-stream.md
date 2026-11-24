---
"authhero": minor
"@authhero/adapter-interfaces": minor
"@authhero/admin": minor
---

Add an Amazon Data Firehose log stream type. A `firehose` stream (`sink`: `aws_region`, `delivery_stream_name`, `aws_access_key_id`, `aws_secret_access_key`, optional `newline_delimited`) is configured per tenant in the admin UI or the management API, and receives each audit event as one record in the Auth0 log stream payload format, sent with SigV4-signed `PutRecordBatch` calls. The secret key is write-only: never returned by the API, kept when an update omits it, and redacted from the audit log. Invalid sinks are rejected with a `400`, and events over Firehose's 1,000 KiB record limit are truncated. `firehose` is an AuthHero extension, not an Auth0 log stream type.

`runOutboxRelay` now accepts `pipeline`, so events retried by the cron drain also reach the Pipelines archive. Previously, an event whose inline archive delivery failed was marked processed by the cron drain without being archived. Archive destinations are now built when the app is created, so an invalid `outbox.pipeline` config fails `init()` instead of failing requests after their writes committed.

`LogsDestination` now recognises duplicate log inserts with the shared `isUniqueViolation` helper, so outbox replays on Postgres (SQLSTATE 23505) and drizzle (whose wrapped "Failed query" errors the old message check missed) are treated as already delivered instead of failing every retry before later destinations run.
