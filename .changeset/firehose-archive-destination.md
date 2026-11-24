---
"authhero": minor
---

Add an Amazon Data Firehose archive destination. Set `init({ outbox: { firehose: { region, deliveryStreamName, accessKeyId, secretAccessKey } } })` to send every audit event, in the same record shape as the Cloudflare Pipelines archive, to a Direct PUT delivery stream (for S3, OpenSearch and other Firehose destinations). Requests are SigV4-signed `PutRecordBatch` calls, and partial batch failures are retried.

`runOutboxRelay` now accepts `pipeline` and `firehose`, so events retried by the cron drain also reach the archives. Previously, an event whose inline archive delivery failed was marked processed by the cron drain without being archived.
