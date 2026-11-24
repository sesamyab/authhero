import { describe, it, expect } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { decodeBase64 } from "@authhero/adapter-interfaces";
import {
  FIREHOSE_MAX_RECORD_BYTES,
  firehoseEndpoint,
  firehoseTargetError,
  putFirehoseRecords,
  type FirehoseTarget,
} from "../../src/helpers/firehose-client";

const SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

const TARGET: FirehoseTarget = {
  region: "eu-north-1",
  deliveryStreamName: "authhero-audit",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: SECRET_ACCESS_KEY,
};

interface Captured {
  request: Request;
  body: string;
}

function parseBody(body: string): {
  DeliveryStreamName: string;
  Records: { Data: string }[];
} {
  return JSON.parse(body);
}

function okResponse(body: string): Response {
  return new Response(
    JSON.stringify({
      FailedPutCount: 0,
      RequestResponses: parseBody(body).Records.map((_, i) => ({
        RecordId: `record-${i}`,
      })),
    }),
    { status: 200 },
  );
}

function makeFetch(respond: (body: string) => Response = okResponse) {
  const calls: Captured[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    if (!(input instanceof Request)) {
      throw new Error("expected a signed Request");
    }
    const body = await input.clone().text();
    calls.push({ request: input, body });
    return respond(body);
  };
  return { calls, fetchImpl };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function decodeRecord(data: string): string {
  return new TextDecoder().decode(decodeBase64(data));
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/**
 * Independent SigV4 computation (node:crypto, not aws4fetch) over the headers
 * the request claims to have signed. Catches a wrong region, service, or
 * signed header set rather than just checking the header looks plausible.
 */
function expectedSignature(request: Request, body: string): string {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(
    /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/([^/]+)\/aws4_request, SignedHeaders=([^,]+), Signature=/,
  );
  if (!match) throw new Error(`unexpected Authorization: ${authorization}`);
  const [, , date, region, service, signedHeaders] = match;
  const url = new URL(request.url);

  const canonicalHeaders = signedHeaders
    .split(";")
    .map((name) => {
      const value =
        name === "host" ? url.host : (request.headers.get(name) ?? "");
      return `${name}:${value.trim()}\n`;
    })
    .join("");
  const canonicalRequest = [
    request.method,
    url.pathname,
    url.search.replace(/^\?/, ""),
    canonicalHeaders,
    signedHeaders,
    sha256Hex(body),
  ].join("\n");

  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    request.headers.get("x-amz-date") ?? "",
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${SECRET_ACCESS_KEY}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  return createHmac("sha256", kSigning).update(stringToSign).digest("hex");
}

describe("putFirehoseRecords", () => {
  it("sends a SigV4-signed PutRecordBatch to the regional endpoint", async () => {
    const { calls, fetchImpl } = makeFetch();

    await putFirehoseRecords(TARGET, [bytes('{"a":1}\n')], { fetchImpl });

    expect(calls).toHaveLength(1);
    const { request, body } = calls[0];
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://firehose.eu-north-1.amazonaws.com/");
    expect(request.headers.get("content-type")).toBe(
      "application/x-amz-json-1.1",
    );
    expect(request.headers.get("x-amz-target")).toBe(
      "Firehose_20150804.PutRecordBatch",
    );

    const authorization = request.headers.get("authorization") ?? "";
    expect(authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-north-1\/firehose\/aws4_request, /,
    );
    // aws4fetch leaves content-type unsigned; the operation is pinned by the
    // signed x-amz-target.
    expect(authorization.match(/SignedHeaders=([^,]+)/)?.[1]).toBe(
      "host;x-amz-date;x-amz-target",
    );
    expect(authorization).toMatch(
      new RegExp(`Signature=${expectedSignature(request, body)}$`),
    );
  });

  it("base64-encodes each record verbatim under the stream name", async () => {
    const { calls, fetchImpl } = makeFetch();

    await putFirehoseRecords(
      TARGET,
      [bytes('{"n":"Brändning ✓"}\n'), bytes('{"n":2}')],
      { fetchImpl },
    );

    const body = parseBody(calls[0].body);
    expect(body.DeliveryStreamName).toBe("authhero-audit");
    expect(body.Records.map((r) => decodeRecord(r.Data))).toEqual([
      '{"n":"Brändning ✓"}\n',
      '{"n":2}',
    ]);
  });

  it("does not call Firehose with no records", async () => {
    const { calls, fetchImpl } = makeFetch();
    await putFirehoseRecords(TARGET, [], { fetchImpl });
    expect(calls).toHaveLength(0);
  });

  it("splits batches above the 500-record PutRecordBatch limit", async () => {
    const { calls, fetchImpl } = makeFetch();
    const records = Array.from({ length: 501 }, (_, i) => bytes(`{"i":${i}}`));

    await putFirehoseRecords(TARGET, records, { fetchImpl });

    expect(calls.map((c) => parseBody(c.body).Records.length)).toEqual([
      500, 1,
    ]);
  });

  it("splits batches above the 4 MiB PutRecordBatch limit", async () => {
    const { calls, fetchImpl } = makeFetch();
    const record = new Uint8Array(900 * 1024).fill(0x78);

    await putFirehoseRecords(TARGET, Array(5).fill(record), { fetchImpl });

    expect(calls.map((c) => parseBody(c.body).Records.length)).toEqual([4, 1]);
  });

  it("refuses to send a record over the per-record limit", async () => {
    const { calls, fetchImpl } = makeFetch();
    const oversized = new Uint8Array(FIREHOSE_MAX_RECORD_BYTES + 1);

    await expect(
      putFirehoseRecords(TARGET, [bytes("{}"), oversized], { fetchImpl }),
    ).rejects.toThrow(/exceeds the per-record limit/);
    expect(calls).toHaveLength(0);
  });

  it("throws on a non-2xx response so the relay retries the event", async () => {
    const { fetchImpl } = makeFetch(
      () =>
        new Response(
          JSON.stringify({
            __type: "ResourceNotFoundException",
            message: "Firehose authhero-audit not found",
          }),
          { status: 400 },
        ),
    );

    await expect(
      putFirehoseRecords(TARGET, [bytes("{}")], { fetchImpl }),
    ).rejects.toThrow(
      /Firehose PutRecordBatch returned 400: .*ResourceNotFoundException/,
    );
  });

  it("throws when Firehose rejects some records in a 200 response", async () => {
    const { fetchImpl } = makeFetch(
      () =>
        new Response(
          JSON.stringify({
            FailedPutCount: 1,
            RequestResponses: [
              { RecordId: "record-0" },
              {
                ErrorCode: "ServiceUnavailableException",
                ErrorMessage: "Slow down.",
              },
            ],
          }),
          { status: 200 },
        ),
    );

    await expect(
      putFirehoseRecords(TARGET, [bytes("{}"), bytes("{}")], { fetchImpl }),
    ).rejects.toThrow(
      "Firehose rejected 1 of 2 records: ServiceUnavailableException: Slow down.",
    );
  });

  it("refuses an invalid target without sending anything", async () => {
    const { calls, fetchImpl } = makeFetch();

    await expect(
      putFirehoseRecords({ ...TARGET, region: "evil.example.com/x" }, [], {
        fetchImpl,
      }),
    ).rejects.toThrow(/invalid AWS region/);
    expect(calls).toHaveLength(0);
  });
});

describe("firehoseEndpoint", () => {
  it("uses amazonaws.com for commercial regions", () => {
    expect(firehoseEndpoint("eu-north-1")).toBe(
      "https://firehose.eu-north-1.amazonaws.com/",
    );
  });

  it("uses amazonaws.com.cn for China-partition regions", () => {
    expect(firehoseEndpoint("cn-north-1")).toBe(
      "https://firehose.cn-north-1.amazonaws.com.cn/",
    );
  });
});

describe("firehoseTargetError", () => {
  it("accepts a complete target", () => {
    expect(firehoseTargetError(TARGET)).toBeUndefined();
  });

  it("rejects a region that could misdirect a signed request", () => {
    expect(
      firehoseTargetError({ ...TARGET, region: "evil.example.com/x" }),
    ).toMatch(/invalid AWS region/);
  });

  it("requires the stream name and both key halves", () => {
    expect(firehoseTargetError({ ...TARGET, deliveryStreamName: "" })).toMatch(
      /delivery stream name is required/,
    );
    expect(firehoseTargetError({ ...TARGET, secretAccessKey: "" })).toMatch(
      /secret access key are required/,
    );
  });
});
