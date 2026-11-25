---
title: Log Stream Recipes (Datadog, Splunk & Firehose)
description: Forward AuthHero audit events to Datadog and Splunk using the built-in HTTP log stream, with an optional relay Worker, or to AWS through an Amazon Data Firehose log stream.
---

# Log Stream Recipes: Datadog, Splunk & Firehose

AuthHero ships two log stream sinks. `type: "http"` POSTs every audit event to a URL you choose, in the same wire shape Auth0 uses. Datadog and Splunk both ingest over HTTP, so you can forward to them without a native sink. `type: "firehose"` sends the same events to an [Amazon Data Firehose](#amazon-data-firehose) stream, for S3, OpenSearch and other AWS destinations.

This page shows how. Datadog works with the stream alone. Splunk needs a small relay Worker, because its HTTP Event Collector (HEC) requires the event wrapped in an envelope that the stream can't produce.

::: warning Only `http` and `firehose` streams deliver
The log stream schema also accepts the types `splunk`, `datadog`, `eventbridge`, `eventgrid` and `sumo`, but the delivery code only sends to streams with `type: "http"` or `type: "firehose"` and `status: "active"`. Streams of any other type are stored and never delivered.
:::

::: tip Requires the outbox
Log streams are delivered by the outbox relay, so `outbox.enabled` must be on and the relay must be running. See [Audit Logging](/features/audit-logging).
:::

## What the stream sends

For each audit event and each matching stream, AuthHero makes one `POST` to `sink.http_endpoint`. Events are not batched.

**Headers**

| Header          | Value                                                                         |
| --------------- | ----------------------------------------------------------------------------- |
| `Content-Type`  | `sink.http_content_type`, default `application/json`                          |
| `Authorization` | `sink.http_authorization`, only if set                                        |
| anything else   | each entry of `sink.http_custom_headers` (`{ header, value }`) is added as-is |

Custom headers are applied last, so they override `Content-Type` and `Authorization` if they use the same name.

**Body**, chosen by `sink.http_content_format`:

| Format                | Body                                     |
| --------------------- | ---------------------------------------- |
| `JSONARRAY` (default) | `[ {event} ]`, an array with one element |
| `JSONOBJECT`          | `{event}`                                |
| `JSONLINES`           | `{event}` followed by `\n`               |

**The event** has this shape (a subset of fields shown; optional fields are omitted when empty):

```json
{
  "log_id": "evt_...",
  "description": "Successful login",
  "data": {
    "date": "2026-10-20T09:15:00.000Z",
    "type": "s",
    "description": "Successful login",
    "tenant_name": "my-tenant",
    "ip": "203.0.113.7",
    "user_agent": "Mozilla/5.0 ...",
    "user_id": "auth2|abc123",
    "user_name": "jane@example.com",
    "client_id": "my-client",
    "connection": "Username-Password-Authentication",
    "strategy": "auth0",
    "audience": "https://api.example.com",
    "scope": "openid profile",
    "hostname": "auth.example.com",
    "details": {
      "request": {
        "method": "POST",
        "path": "/oauth/token",
        "qs": {},
        "body": {}
      },
      "response": { "statusCode": 200, "body": {} }
    }
  }
}
```

`log_id` is the audit event id and is stable across retries, so use it to deduplicate downstream.

**Filtering.** `filters` is an array of `{ "type": "category", "name": "<log type>" }`. An event is sent when its log type (`s`, `f`, `fp`, ...) matches the `name` of any filter. With no filters, every event is sent. Events whose type starts with `hook.` or `controlplane.sync.` are never sent to log streams.

## Retries and failure behaviour

- A request that returns a non-2xx status, or doesn't finish within **10 seconds**, counts as a failure. Redirects are followed by `fetch`.
- A failure is retried by the outbox relay with exponential backoff: `1s × 2^n`, capped at 5 minutes, for up to **5 retries**. After that the event is dead-lettered and not delivered to the stream again.
- The error text (`Log stream <id> returned <status>: <first 256 chars of response body>`) is stored on the outbox event, which is the first place to look when a sink isn't receiving data.
- Retries are per event, not per stream. A tenant's active streams are tried in order and delivery stops at the first failure. Streams before it have already received the event and receive it again on each retry; streams after it don't receive it until a retry gets past the failing one, and never receive it if the retries run out. One unreliable stream can therefore delay or drop delivery to the others, so make sure each sink answers reliably, and deduplicate on `log_id`.
- A relay or sink must therefore return a 2xx **only** once it has accepted the event, and a non-2xx when it hasn't. Don't swallow errors.

## Datadog: direct, no relay

The Datadog logs intake accepts a JSON array and authenticates with a `DD-API-KEY` header. That's exactly what the stream's default format and custom headers produce.

Create the stream with the Management API (`POST /api/v2/log-streams`):

```json
{
  "name": "datadog",
  "type": "http",
  "sink": {
    "http_endpoint": "https://http-intake.logs.datadoghq.com/api/v2/logs",
    "http_content_type": "application/json",
    "http_content_format": "JSONARRAY",
    "http_custom_headers": [
      { "header": "DD-API-KEY", "value": "<your Datadog API key>" }
    ]
  }
}
```

Use the intake URL for your Datadog site (for example `https://http-intake.logs.datadoghq.eu/api/v2/logs` for EU1). Datadog answers `202 Accepted`. Datadog documents limits of 1000 entries and 5 MB per request, and 1 MB per log; the entry count is never an issue because AuthHero sends one event per request. The 1 MB per-log limit can be: the payload includes `details.request.body` and `details.response.body`, and Datadog truncates an oversized log while still answering `202`, so AuthHero counts the event as delivered. If your tenants produce large bodies, trim them in a relay before forwarding.

### Make the logs readable in Datadog

Datadog treats `message` as the log body, and AuthHero's payload has no `message`. It nests everything under `data`. Add a log pipeline in Datadog (Logs → Configuration → Pipelines) with:

1. A **Message remapper** from `description` (or `data.description`).
2. A **Date remapper** from `data.date`, so events are timestamped by when they happened, not when Datadog received them.
3. Optionally a **Service remapper** or a static tag, so you can filter on `service:authhero`.

If you'd rather set these fields at the source, use the relay below and send `message`, `ddsource`, `service` and `ddtags` yourself.

## Splunk: through a relay Worker

Splunk HEC's `/services/collector/event` endpoint expects each event inside an envelope, with the payload under an `event` key and the timestamp in `time`. AuthHero's log stream can set the URL, headers and content type, but it cannot wrap the body, so the request has to pass through a small relay. The Worker below also translates the credentials, so the Splunk HEC token never has to live in AuthHero's database.

The HEC token must not have indexer acknowledgment enabled: with acknowledgment on, HEC requires a channel identifier on every request, which this relay doesn't send, and every event would fail. Check the envelope against the [Splunk HEC documentation](https://docs.splunk.com/Documentation/Splunk/latest/Data/FormateventsforHTTPEventCollector) for your Splunk version before deploying.

### 1. The relay Worker

```ts
// src/index.ts
interface Env {
  RELAY_TOKEN: string; // shared secret AuthHero sends as Authorization
  SPLUNK_HEC_URL: string; // e.g. https://splunk.example.com:8088/services/collector/event
  SPLUNK_HEC_TOKEN: string;
  SPLUNK_INDEX?: string;
}

interface AuthHeroEvent {
  log_id: string;
  description?: string;
  data: { date: string; type: string; tenant_name: string; hostname?: string };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    if (request.headers.get("Authorization") !== `Bearer ${env.RELAY_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }

    // JSONARRAY sends [event]; accept a bare object too.
    const body = await request.json<AuthHeroEvent | AuthHeroEvent[]>();
    const events = Array.isArray(body) ? body : [body];

    // HEC accepts several envelopes concatenated in one body.
    const payload = events
      .map((e) =>
        JSON.stringify({
          time: Date.parse(e.data.date) / 1000,
          host: e.data.hostname ?? "authhero",
          source: `authhero:${e.data.tenant_name}`,
          sourcetype: "authhero:log",
          ...(env.SPLUNK_INDEX && { index: env.SPLUNK_INDEX }),
          event: e,
        }),
      )
      .join("\n");

    const upstream = await fetch(env.SPLUNK_HEC_URL, {
      method: "POST",
      headers: { Authorization: `Splunk ${env.SPLUNK_HEC_TOKEN}` },
      body: payload,
    });

    // Pass failures through so AuthHero's outbox retries the event.
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      return new Response(
        `Splunk HEC ${upstream.status}: ${text.slice(0, 200)}`,
        {
          status: 502,
        },
      );
    }
    return new Response("ok");
  },
};
```

Returning `502` on any upstream failure matters: it is what makes AuthHero retry. The relay itself does no retrying, because AuthHero already backs off and retries for you.

Give the Worker a name in `wrangler.jsonc` so the commands below know which Worker to target:

```jsonc
{
  "name": "authhero-splunk-relay",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
}
```

Then set the secrets and deploy:

```bash
npx wrangler secret put RELAY_TOKEN
npx wrangler secret put SPLUNK_HEC_TOKEN
npx wrangler secret put SPLUNK_HEC_URL
npx wrangler deploy
```

### 2. The log stream

```json
{
  "name": "splunk",
  "type": "http",
  "sink": {
    "http_endpoint": "https://authhero-splunk-relay.<account>.workers.dev",
    "http_authorization": "Bearer <RELAY_TOKEN>",
    "http_content_type": "application/json",
    "http_content_format": "JSONARRAY"
  }
}
```

### 3. Check it works

Trigger a login, then in Splunk search `sourcetype="authhero:log"`. If nothing arrives, look at the dead-lettered and retrying outbox events: the stored error contains the relay's status and the first 256 characters of its response.

## Datadog through a relay (optional)

Reach for a relay with Datadog only if you need to set `message`, `ddsource`, `service` or `ddtags` at the source rather than in a Datadog pipeline, or to keep the API key out of AuthHero. The shape is the same as the Splunk Worker: authenticate the caller, map each event to this shape:

```ts
const log = {
  ddsource: "authhero",
  service: "authhero",
  ddtags: `tenant:${e.data.tenant_name}`,
  hostname: e.data.hostname,
  message: e.description,
  ...e,
};
```

Then `POST` the array to `https://http-intake.logs.<site>/api/v2/logs` with a `DD-API-KEY` header, and return a non-2xx when Datadog doesn't answer `202`.

## Amazon Data Firehose

A `firehose` stream sends each event to an [Amazon Data Firehose](https://docs.aws.amazon.com/firehose/) Direct PUT delivery stream, which forwards it to S3, OpenSearch, or any other Firehose destination. It is configured per tenant like any log stream: in the admin UI under **Log Streams → Create → Amazon Data Firehose**, or through the management API. `firehose` is an AuthHero extension, not an Auth0 log stream type, so Auth0 tooling (the Terraform provider, the Deploy CLI) doesn't know it.

```json
{
  "name": "aws-audit",
  "type": "firehose",
  "status": "active",
  "sink": {
    "aws_region": "eu-north-1",
    "delivery_stream_name": "authhero-logs",
    "aws_access_key_id": "AKIA...",
    "aws_secret_access_key": "...",
    "newline_delimited": true
  }
}
```

**Credentials.** Requests are SigV4-signed `PutRecordBatch` calls with the access key in the sink. Create an IAM user for it with nothing but:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "firehose:PutRecordBatch",
      "Resource": "arn:aws:firehose:eu-north-1:<account-id>:deliverystream/authhero-logs"
    }
  ]
}
```

`aws_secret_access_key` is write-only: the management API stores it but never returns it, and it is redacted from the audit log. To keep the current secret when updating the sink, leave it out (the admin UI does this when the field is left blank); send a new value to rotate it. The API rejects a sink without a usable region, stream name or key pair with a `400`. Regions in the China partition (`cn-*`) use the `amazonaws.com.cn` endpoint.

**What is sent.** Each event is one Firehose record holding the same JSON payload an `http` stream sends (`log_id`, `description`, `data`), terminated with a newline so the objects Firehose writes to S3 are JSON Lines. Set `newline_delimited: false` to send the bare JSON document instead.

**Oversized events.** Firehose caps a record at 1,000 KiB. For an event over that, `data.details` is replaced with the request method and path plus `truncated: true` and `original_bytes`; the rest of the payload is kept. An event still too large after that is logged and not sent.

**OpenSearch.** `data.details` carries request and response bodies with arbitrary keys. With dynamic mapping these grow the index's field count without bound, so map `data.details` as `flat_object` (or `{ "type": "object", "enabled": false }`) in the index template. Firehose assigns its own document ids, so deduplicate on `log_id` at query time.

**Failures.** A Firehose error, including a `200` response that reports failed records, counts as a failed delivery and is retried as described in [Retries and failure behaviour](#retries-and-failure-behaviour).

## Notes

- **Secrets.** `http_authorization` and `http_custom_headers` are stored in the stream's `sink` in your database. Use a scoped or rotatable key, or keep the real credential in the relay and give AuthHero only a relay token.
- **`http_authorization` is write-only.** Like the Firehose secret, the management API stores it but never returns it, and redacts it from the audit log. When updating a sink, leave it out (or send an empty string) to keep the stored header, send a new value to replace it, or send `null` to remove it. In the admin UI, a blank field keeps the header and **Remove the stored Authorization header** clears it. `http_custom_headers` is still returned as stored, so don't put credentials there if API readers shouldn't see them.
- **Volume.** One request per event per stream means busy tenants make many small requests. Datadog and HEC both handle that, but a relay on Workers is billed per request.
- **Native sinks.** Native Datadog and Splunk sinks are not implemented. This recipe is the supported path today.

## Related

- [Audit Logging](/features/audit-logging): the outbox, relay and scheduled drain that deliver log streams
- [Architecture: Audit Events](/architecture/audit-events)
