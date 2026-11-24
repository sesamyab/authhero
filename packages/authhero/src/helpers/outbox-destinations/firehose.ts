import { AuditEvent, encodeBase64 } from "@authhero/adapter-interfaces";
import { AwsClient } from "aws4fetch";
import { EventDestination } from "../outbox-relay";
import {
  isArchivableEvent,
  toArchiveRecord,
  type PipelineRecord,
} from "./pipeline";

const DEFAULT_DELIVERY_TIMEOUT_MS = 10_000;

// PutRecordBatch limits: 500 records and 4 MiB of record data per call, and
// 1,000 KiB per record (before base64 encoding).
// https://docs.aws.amazon.com/firehose/latest/APIReference/API_PutRecordBatch.html
const MAX_RECORDS_PER_BATCH = 500;
const MAX_BYTES_PER_BATCH = 4 * 1024 * 1024;
const MAX_BYTES_PER_RECORD = 1000 * 1024;

const REGION_PATTERN = /^[a-z0-9-]+$/;

export interface FirehoseDestinationOptions {
  /** AWS region of the delivery stream, e.g. `eu-north-1`. */
  region: string;
  /** Name (not ARN) of the Direct PUT delivery stream. */
  deliveryStreamName: string;
  /** Access key of an IAM principal allowed `firehose:PutRecordBatch` on the stream. */
  accessKeyId: string;
  secretAccessKey: string;
  /** Only needed for temporary (STS) credentials. */
  sessionToken?: string;
  /**
   * Terminate each record with `\n` so records concatenated into one S3
   * object are newline-delimited JSON (default: true). Firehose adds no
   * delimiter of its own.
   */
  newlineDelimited?: boolean;
  /** Per-request timeout (default: 10s). */
  timeoutMs?: number;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
}

interface PutRecordBatchEntry {
  ErrorCode?: string;
  ErrorMessage?: string;
}

interface PutRecordBatchResult {
  FailedPutCount: number;
  RequestResponses: PutRecordBatchEntry[];
}

/**
 * The archive row for an event that is too big for one Firehose record. Keeps
 * the promoted columns and the event's who/what/when, and drops the fields
 * that can grow without bound: entity snapshots, request/response bodies and
 * caller-supplied `details`. `details` records that the row was cut down and
 * how big it was, so consumers can tell a truncated row from a sparse one.
 */
function truncateArchiveRecord(
  record: PipelineRecord,
  originalBytes: number,
): PipelineRecord {
  const { event } = record;
  return {
    ...record,
    event: {
      ...event,
      target: { type: event.target.type, id: event.target.id },
      request: { ...event.request, body: undefined },
      response: event.response
        ? { ...event.response, body: undefined }
        : undefined,
      details: {
        archive_truncated: true,
        archive_original_bytes: originalBytes,
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePutRecordBatchResult(value: unknown): PutRecordBatchResult {
  if (!isRecord(value) || typeof value.FailedPutCount !== "number") {
    throw new Error("Firehose PutRecordBatch returned an unexpected body");
  }
  const responses = Array.isArray(value.RequestResponses)
    ? value.RequestResponses.filter(isRecord).map((entry) => ({
        ErrorCode:
          typeof entry.ErrorCode === "string" ? entry.ErrorCode : undefined,
        ErrorMessage:
          typeof entry.ErrorMessage === "string"
            ? entry.ErrorMessage
            : undefined,
      }))
    : [];
  return { FailedPutCount: value.FailedPutCount, RequestResponses: responses };
}

/**
 * Archives audit events to an Amazon Data Firehose delivery stream, which
 * forwards them to S3, OpenSearch, or any other Firehose destination. The
 * record shape is the same as `PipelineDestination`'s, so both archives can
 * be queried the same way.
 *
 * Configured once per deployment (`init({ outbox: { firehose } })`), not per
 * tenant: every tenant's events go to the same stream, keyed by `tenant_id`.
 *
 * Requests are SigV4-signed with static IAM credentials. Grant the principal
 * only `firehose:PutRecordBatch` on the one stream ARN.
 *
 * Duplicates are expected, as with `PipelineDestination`: the relay retries
 * per event, and a `PutRecordBatch` with any failed record is retried whole.
 * Consumers dedup on `id`.
 */
export class FirehoseDestination implements EventDestination {
  name = "firehose";
  private client: AwsClient;
  private endpoint: string;
  private deliveryStreamName: string;
  private newlineDelimited: boolean;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;

  constructor(options: FirehoseDestinationOptions) {
    // The region is interpolated into the endpoint hostname, so reject
    // anything that could redirect a signed request elsewhere. Fails at
    // construction so a misconfiguration surfaces at startup.
    if (!REGION_PATTERN.test(options.region)) {
      throw new Error(
        `FirehoseDestination: invalid region: ${JSON.stringify(options.region)}`,
      );
    }
    if (!options.deliveryStreamName) {
      throw new Error("FirehoseDestination: deliveryStreamName is required");
    }
    if (!options.accessKeyId || !options.secretAccessKey) {
      throw new Error(
        "FirehoseDestination: accessKeyId and secretAccessKey are required",
      );
    }

    this.client = new AwsClient({
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      sessionToken: options.sessionToken,
      service: "firehose",
      region: options.region,
    });
    // China regions are a separate AWS partition with their own domain.
    const domain = options.region.startsWith("cn-")
      ? "amazonaws.com.cn"
      : "amazonaws.com";
    this.endpoint = `https://firehose.${options.region}.${domain}/`;
    this.deliveryStreamName = options.deliveryStreamName;
    this.newlineDelimited = options.newlineDelimited ?? true;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
    // Wrap the global fetch so it is never invoked with `this` bound to the
    // destination — workerd's brand check rejects that with
    // "TypeError: Illegal invocation".
    this.fetchImpl =
      options.fetchImpl ??
      ((...args: Parameters<typeof fetch>) => fetch(...args));
  }

  accepts(event: AuditEvent): boolean {
    return isArchivableEvent(event);
  }

  transform(event: AuditEvent): PipelineRecord {
    return toArchiveRecord(event);
  }

  private encode(record: PipelineRecord): Uint8Array {
    const json = JSON.stringify(record);
    return new TextEncoder().encode(this.newlineDelimited ? `${json}\n` : json);
  }

  /**
   * Encodes a record within Firehose's per-record limit, so one oversized row
   * cannot fail (and on retry, keep failing) the whole batch. An oversized
   * row is archived truncated; one still too big after that — only possible
   * with pathological top-level fields — is logged and skipped rather than
   * retried forever.
   */
  private encodeWithinLimit(record: PipelineRecord): Uint8Array | undefined {
    const bytes = this.encode(record);
    if (bytes.length <= MAX_BYTES_PER_RECORD) return bytes;

    const truncated = this.encode(truncateArchiveRecord(record, bytes.length));
    if (truncated.length <= MAX_BYTES_PER_RECORD) {
      console.warn(
        `Firehose: archived event ${record.id} truncated from ${bytes.length} bytes to fit the per-record limit`,
      );
      return truncated;
    }

    console.error(
      `Firehose: skipped event ${record.id}: ${truncated.length} bytes after truncation exceeds the per-record limit`,
    );
    return undefined;
  }

  async deliver(records: PipelineRecord[]): Promise<void> {
    let batch: string[] = [];
    let batchBytes = 0;

    for (const record of records) {
      const bytes = this.encodeWithinLimit(record);
      if (!bytes) continue;
      if (
        batch.length > 0 &&
        (batch.length >= MAX_RECORDS_PER_BATCH ||
          batchBytes + bytes.length > MAX_BYTES_PER_BATCH)
      ) {
        await this.putRecordBatch(batch);
        batch = [];
        batchBytes = 0;
      }
      batch.push(encodeBase64(bytes));
      batchBytes += bytes.length;
    }

    if (batch.length > 0) {
      await this.putRecordBatch(batch);
    }
  }

  private async putRecordBatch(data: string[]): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const request = await this.client.sign(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-amz-json-1.1",
          "X-Amz-Target": "Firehose_20150804.PutRecordBatch",
        },
        body: JSON.stringify({
          DeliveryStreamName: this.deliveryStreamName,
          Records: data.map((Data) => ({ Data })),
        }),
        signal: controller.signal,
      });
      const response = await this.fetchImpl(request);

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `Firehose PutRecordBatch returned ${response.status}: ${body.slice(0, 256)}`,
        );
      }

      // A 200 can still carry per-record failures (throttling, internal
      // errors). Throw so the relay retries the event rather than marking it
      // delivered with records missing from the stream.
      const result = parsePutRecordBatchResult(await response.json());
      if (result.FailedPutCount > 0) {
        const firstError = result.RequestResponses.find((r) => r.ErrorCode);
        const detail = firstError
          ? `: ${firstError.ErrorCode}: ${firstError.ErrorMessage ?? ""}`
          : "";
        throw new Error(
          `Firehose rejected ${result.FailedPutCount} of ${data.length} records${detail}`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
