import { encodeBase64 } from "@authhero/adapter-interfaces";
import { AwsClient } from "aws4fetch";

const DEFAULT_TIMEOUT_MS = 10_000;

// PutRecordBatch limits: 500 records and 4 MiB of record data per call, and
// 1,000 KiB per record (before base64 encoding).
// https://docs.aws.amazon.com/firehose/latest/APIReference/API_PutRecordBatch.html
const MAX_RECORDS_PER_BATCH = 500;
const MAX_BYTES_PER_BATCH = 4 * 1024 * 1024;
export const FIREHOSE_MAX_RECORD_BYTES = 1000 * 1024;

const REGION_PATTERN = /^[a-z0-9-]+$/;

export interface FirehoseTarget {
  /** AWS region of the delivery stream, e.g. `eu-north-1`. */
  region: string;
  /** Name (not ARN) of the Direct PUT delivery stream. */
  deliveryStreamName: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface PutFirehoseRecordsOptions {
  /** Per-request timeout (default: 10s). */
  timeoutMs?: number;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * Why a target cannot be used, or `undefined` when it can. The region is
 * interpolated into the endpoint hostname, so anything but a plain region id
 * is rejected — it could otherwise redirect a signed request elsewhere.
 */
export function firehoseTargetError(
  target: FirehoseTarget,
): string | undefined {
  if (!REGION_PATTERN.test(target.region)) {
    return `invalid AWS region: ${JSON.stringify(target.region)}`;
  }
  if (!target.deliveryStreamName) return "delivery stream name is required";
  if (!target.accessKeyId || !target.secretAccessKey) {
    return "AWS access key id and secret access key are required";
  }
  return undefined;
}

export function firehoseEndpoint(region: string): string {
  // China regions are a separate AWS partition with their own domain.
  const domain = region.startsWith("cn-")
    ? "amazonaws.com.cn"
    : "amazonaws.com";
  return `https://firehose.${region}.${domain}/`;
}

interface PutRecordBatchEntry {
  ErrorCode?: string;
  ErrorMessage?: string;
}

interface PutRecordBatchResult {
  FailedPutCount: number;
  RequestResponses: PutRecordBatchEntry[];
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

async function putRecordBatch(
  client: AwsClient,
  target: FirehoseTarget,
  data: string[],
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const request = await client.sign(firehoseEndpoint(target.region), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target": "Firehose_20150804.PutRecordBatch",
      },
      body: JSON.stringify({
        DeliveryStreamName: target.deliveryStreamName,
        Records: data.map((Data) => ({ Data })),
      }),
      signal: controller.signal,
    });
    const response = await fetchImpl(request);

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

/**
 * Sends already-encoded records to an Amazon Data Firehose Direct PUT stream
 * with SigV4-signed `PutRecordBatch` calls, split at the per-call limits.
 * Callers keep each record within `FIREHOSE_MAX_RECORD_BYTES`; this throws
 * before sending if one is not, since Firehose would reject the whole call.
 */
export async function putFirehoseRecords(
  target: FirehoseTarget,
  records: Uint8Array[],
  options: PutFirehoseRecordsOptions = {},
): Promise<void> {
  const targetError = firehoseTargetError(target);
  if (targetError) throw new Error(`Firehose: ${targetError}`);
  const oversized = records.find((r) => r.length > FIREHOSE_MAX_RECORD_BYTES);
  if (oversized) {
    throw new Error(
      `Firehose: a ${oversized.length}-byte record exceeds the per-record limit`,
    );
  }
  if (records.length === 0) return;

  const client = new AwsClient({
    accessKeyId: target.accessKeyId,
    secretAccessKey: target.secretAccessKey,
    service: "firehose",
    region: target.region,
  });
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // Wrap the global fetch so it is never invoked with `this` bound to another
  // object — workerd's brand check rejects that with "Illegal invocation".
  const fetchImpl =
    options.fetchImpl ??
    ((...args: Parameters<typeof fetch>) => fetch(...args));

  let batch: string[] = [];
  let batchBytes = 0;
  for (const bytes of records) {
    if (
      batch.length > 0 &&
      (batch.length >= MAX_RECORDS_PER_BATCH ||
        batchBytes + bytes.length > MAX_BYTES_PER_BATCH)
    ) {
      await putRecordBatch(client, target, batch, timeoutMs, fetchImpl);
      batch = [];
      batchBytes = 0;
    }
    batch.push(encodeBase64(bytes));
    batchBytes += bytes.length;
  }
  if (batch.length > 0) {
    await putRecordBatch(client, target, batch, timeoutMs, fetchImpl);
  }
}
