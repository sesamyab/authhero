---
"authhero": minor
---

Add an Amazon Data Firehose archive destination. Set `init({ outbox: { firehose: { region, deliveryStreamName, accessKeyId, secretAccessKey } } })` to send every audit event, in the same record shape as the Cloudflare Pipelines archive, to a Direct PUT delivery stream (for S3, OpenSearch and other Firehose destinations). Requests are SigV4-signed `PutRecordBatch` calls, and partial batch failures are retried.

`runOutboxRelay` now accepts `pipeline` and `firehose`, so events retried by the cron drain also reach the archives. Previously, an event whose inline archive delivery failed was marked processed by the cron drain without being archived.

`LogsDestination` now recognises duplicate log inserts with the shared `isUniqueViolation` helper, so outbox replays on Postgres (SQLSTATE 23505) and drizzle (whose wrapped "Failed query" errors the old message check missed) are treated as already delivered instead of failing every retry before later destinations run.
