import { describe, it, expect } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { decodeBase64, type AuditEvent } from "@authhero/adapter-interfaces";
import {
  FirehoseDestination,
  type FirehoseDestinationOptions,
} from "../../../src/helpers/outbox-destinations/firehose";
import {
  PipelineDestination,
  type PipelineRecord,
} from "../../../src/helpers/outbox-destinations/pipeline";

const ACCESS_KEY_ID = "AKIDEXAMPLE";
const SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "evt-1",
    tenant_id: "tenant-1",
    event_type: "branding.updated",
    log_type: "sapi",
    category: "admin_action",
    actor: { type: "admin", id: "admin-1", email: "admin@example.com" },
    target: {
      type: "branding",
      id: "branding",
      before: { colors: { primary: "#000" } },
      after: { colors: { primary: "#fff" } },
    },
    request: { method: "PATCH", path: "/api/v2/branding", ip: "127.0.0.1" },
    hostname: "localhost",
    timestamp: "2026-05-21T00:00:00.000Z",
    ...overrides,
  };
}

function okResponse(recordCount: number): Response {
  return new Response(
    JSON.stringify({
      FailedPutCount: 0,
      Encrypted: false,
      RequestResponses: Array.from({ length: recordCount }, (_, i) => ({
        RecordId: `record-${i}`,
      })),
    }),
    { status: 200, headers: { "Content-Type": "application/x-amz-json-1.1" } },
  );
}

interface Captured {
  request: Request;
  body: string;
}

function makeFetch(respond: (body: string) => Response = defaultRespond) {
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

function defaultRespond(body: string): Response {
  return okResponse(parseBody(body).Records.length);
}

function parseBody(body: string): {
  DeliveryStreamName: string;
  Records: { Data: string }[];
} {
  return JSON.parse(body);
}

function decodeRecord(data: string): string {
  return new TextDecoder().decode(decodeBase64(data));
}

function makeDestination(
  fetchImpl: typeof fetch,
  overrides: Partial<FirehoseDestinationOptions> = {},
) {
  return new FirehoseDestination({
    region: "eu-north-1",
    deliveryStreamName: "authhero-audit",
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
    fetchImpl,
    ...overrides,
  });
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

describe("FirehoseDestination", () => {
  it("produces the same archive record as the Pipelines destination", () => {
    const { fetchImpl } = makeFetch();
    const firehose = makeDestination(fetchImpl);
    const pipeline = new PipelineDestination({
      endpoint: "https://stream-1.ingest.cloudflare.com",
      token: "t",
      fetchImpl,
    });
    const event = makeEvent();

    expect(firehose.transform(event)).toEqual(pipeline.transform(event));
    expect(firehose.transform(event).event).toBe(event);
  });

  it("archives audit events but not hook.* / controlplane.sync.* plumbing", () => {
    const dest = makeDestination(makeFetch().fetchImpl);

    expect(dest.accepts(makeEvent())).toBe(true);
    expect(
      dest.accepts(makeEvent({ event_type: "hook.post-user-registration" })),
    ).toBe(false);
    expect(
      dest.accepts(
        makeEvent({ event_type: "controlplane.sync.proxy_route.created" }),
      ),
    ).toBe(false);
  });

  it("sends a SigV4-signed PutRecordBatch to the regional endpoint", async () => {
    const { calls, fetchImpl } = makeFetch();
    const dest = makeDestination(fetchImpl);

    await dest.deliver([dest.transform(makeEvent())]);

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
    expect(request.headers.get("x-amz-security-token")).toBeNull();

    const authorization = request.headers.get("authorization") ?? "";
    expect(authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-north-1\/firehose\/aws4_request, /,
    );
    const signedHeaders = authorization.match(/SignedHeaders=([^,]+)/)?.[1];
    // aws4fetch leaves content-type unsigned; the operation is pinned by the
    // signed x-amz-target.
    expect(signedHeaders?.split(";")).toEqual([
      "host",
      "x-amz-date",
      "x-amz-target",
    ]);
    expect(authorization).toMatch(
      new RegExp(`Signature=${expectedSignature(request, body)}$`),
    );
  });

  it("encodes each record as base64 newline-terminated JSON", async () => {
    const { calls, fetchImpl } = makeFetch();
    const dest = makeDestination(fetchImpl);
    const records: PipelineRecord[] = [
      dest.transform(makeEvent()),
      dest.transform(
        makeEvent({ id: "evt-2", description: "Brändning uppdaterad ✓" }),
      ),
    ];

    await dest.deliver(records);

    const body = parseBody(calls[0].body);
    expect(body.DeliveryStreamName).toBe("authhero-audit");
    expect(body.Records).toHaveLength(2);
    const decoded = body.Records.map((r) => decodeRecord(r.Data));
    expect(decoded.every((line) => line.endsWith("\n"))).toBe(true);
    expect(decoded.map((line) => JSON.parse(line))).toEqual(records);
  });

  it("omits the newline when newlineDelimited is false", async () => {
    const { calls, fetchImpl } = makeFetch();
    const dest = makeDestination(fetchImpl, { newlineDelimited: false });
    const record = dest.transform(makeEvent());

    await dest.deliver([record]);

    const data = parseBody(calls[0].body).Records[0].Data;
    expect(decodeRecord(data)).toBe(JSON.stringify(record));
  });

  it("sends the session token for temporary credentials", async () => {
    const { calls, fetchImpl } = makeFetch();
    const dest = makeDestination(fetchImpl, { sessionToken: "session-token" });

    await dest.deliver([dest.transform(makeEvent())]);

    expect(calls[0].request.headers.get("x-amz-security-token")).toBe(
      "session-token",
    );
  });

  it("does not call Firehose for an empty batch", async () => {
    const { calls, fetchImpl } = makeFetch();
    await makeDestination(fetchImpl).deliver([]);

    expect(calls).toHaveLength(0);
  });

  it("splits batches above the 500-record PutRecordBatch limit", async () => {
    const { calls, fetchImpl } = makeFetch();
    const dest = makeDestination(fetchImpl);
    const records = Array.from({ length: 501 }, (_, i) =>
      dest.transform(makeEvent({ id: `evt-${i}` })),
    );

    await dest.deliver(records);

    expect(calls.map((c) => parseBody(c.body).Records.length)).toEqual([
      500, 1,
    ]);
  });

  it("splits batches above the 4 MiB PutRecordBatch limit", async () => {
    const { calls, fetchImpl } = makeFetch();
    const dest = makeDestination(fetchImpl);
    const padding = "x".repeat(900 * 1024);
    const records = Array.from({ length: 5 }, (_, i) =>
      dest.transform(makeEvent({ id: `evt-${i}`, description: padding })),
    );

    await dest.deliver(records);

    // ~900 KiB per record, so four fit under 4 MiB and the fifth spills
    // into a second call.
    expect(calls.map((c) => parseBody(c.body).Records.length)).toEqual([4, 1]);
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
    const dest = makeDestination(fetchImpl);

    await expect(dest.deliver([dest.transform(makeEvent())])).rejects.toThrow(
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
    const dest = makeDestination(fetchImpl);

    await expect(
      dest.deliver([
        dest.transform(makeEvent()),
        dest.transform(makeEvent({ id: "evt-2" })),
      ]),
    ).rejects.toThrow(
      "Firehose rejected 1 of 2 records: ServiceUnavailableException: Slow down.",
    );
  });

  it("rejects configuration that could misdirect a signed request", () => {
    const fetchImpl = makeFetch().fetchImpl;

    expect(() =>
      makeDestination(fetchImpl, { region: "evil.example.com/x" }),
    ).toThrow(/invalid region/);
    expect(() =>
      makeDestination(fetchImpl, { deliveryStreamName: "" }),
    ).toThrow(/deliveryStreamName is required/);
    expect(() => makeDestination(fetchImpl, { secretAccessKey: "" })).toThrow(
      /accessKeyId and secretAccessKey are required/,
    );
  });
});
