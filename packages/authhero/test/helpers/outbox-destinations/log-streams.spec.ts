import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type {
  AuditEvent,
  LogStream,
  LogStreamsAdapter,
} from "@authhero/adapter-interfaces";
import { decodeBase64 } from "@authhero/adapter-interfaces";
import {
  LogStreamDestination,
  parseFirehoseSink,
} from "../../../src/helpers/outbox-destinations/log-streams";

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "evt-1",
    tenant_id: "tenant-1",
    event_type: "user.created",
    log_type: "sapi",
    category: "api",
    actor: { type: "admin", email: "admin@example.com" },
    target: { type: "user", id: "user-1" },
    request: { method: "POST", path: "/users", ip: "127.0.0.1" },
    hostname: "localhost",
    timestamp: "2026-05-21T00:00:00.000Z",
    ...overrides,
  };
}

function makeStreams(streams: LogStream[]): LogStreamsAdapter {
  return {
    list: vi.fn().mockResolvedValue(streams),
  } as unknown as LogStreamsAdapter;
}

describe("LogStreamDestination", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects hook.* events", () => {
    const dest = new LogStreamDestination(makeStreams([]));
    expect(dest.accepts(makeEvent())).toBe(true);
    expect(dest.accepts(makeEvent({ event_type: "hook.foo" }))).toBe(false);
  });

  it("does not POST when there are no active http streams", async () => {
    const dest = new LogStreamDestination(
      makeStreams([
        {
          id: "lst_1",
          name: "paused",
          type: "http",
          status: "paused",
          sink: { http_endpoint: "https://nope.test" },
        },
        {
          id: "lst_2",
          name: "datadog",
          type: "datadog",
          status: "active",
          sink: {},
        },
      ]),
    );
    await dest.deliver([dest.transform(makeEvent())]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("only names the actor in user_name when the subject is the actor", () => {
    const dest = new LogStreamDestination(makeStreams([]));
    const targetUser = dest.transform(
      makeEvent({
        actor: { type: "admin", id: "admin-1", email: "admin@example.com" },
      }),
    );
    expect(targetUser.payload.data.user_id).toBe("user-1");
    expect(targetUser.payload.data.user_name).toBeUndefined();

    const selfEvent = dest.transform(
      makeEvent({
        actor: { type: "user", id: "user-1", email: "user@example.com" },
      }),
    );
    expect(selfEvent.payload.data.user_name).toBe("user@example.com");
  });

  it("POSTs to active http sink with auth + content type headers", async () => {
    const dest = new LogStreamDestination(
      makeStreams([
        {
          id: "lst_1",
          name: "loki",
          type: "http",
          status: "active",
          sink: {
            http_endpoint: "https://logs.test/in",
            http_authorization: "Basic abc",
            http_content_type: "application/json",
            http_content_format: "JSONARRAY",
          },
        },
      ]),
    );
    await dest.deliver([dest.transform(makeEvent())]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://logs.test/in");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers["Authorization"]).toBe("Basic abc");
    const body = JSON.parse(init.body);
    expect(Array.isArray(body)).toBe(true);
    expect(body[0].log_id).toBe("evt-1");
    expect(body[0].data.tenant_name).toBe("tenant-1");
    expect(body[0].data.type).toBe("sapi");
  });

  it("carries redirect_uri, authorization_url and execution_id into details", async () => {
    const dest = new LogStreamDestination(
      makeStreams([
        {
          id: "lst_1",
          name: "loki",
          type: "http",
          status: "active",
          sink: {
            http_endpoint: "https://logs.test/in",
            http_content_type: "application/json",
            http_content_format: "JSONARRAY",
          },
        },
      ]),
    );
    await dest.deliver([
      dest.transform(
        makeEvent({
          log_type: "s",
          request: {
            method: "GET",
            path: "/callback",
            ip: "1.2.3.4",
            redirect_uri: "https://app.example.com/cb",
            authorization_url:
              "https://auth.example.com/authorize?utm_campaign=oct",
          },
          execution_id: "exec-1",
        }),
      ),
    ]);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body[0].data.details.request.redirect_uri).toBe(
      "https://app.example.com/cb",
    );
    expect(body[0].data.details.request.authorization_url).toBe(
      "https://auth.example.com/authorize?utm_campaign=oct",
    );
    expect(body[0].data.details.execution_id).toBe("exec-1");
  });

  it("encodes JSONLINES format with trailing newline", async () => {
    const dest = new LogStreamDestination(
      makeStreams([
        {
          id: "lst_1",
          name: "lines",
          type: "http",
          status: "active",
          sink: {
            http_endpoint: "https://logs.test/in",
            http_content_format: "JSONLINES",
          },
        },
      ]),
    );
    await dest.deliver([dest.transform(makeEvent())]);
    const init = fetchMock.mock.calls[0][1];
    expect(init.body.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(init.body.trim());
    expect(parsed.log_id).toBe("evt-1");
  });

  it("encodes JSONOBJECT format as a bare object", async () => {
    const dest = new LogStreamDestination(
      makeStreams([
        {
          id: "lst_1",
          name: "obj",
          type: "http",
          status: "active",
          sink: {
            http_endpoint: "https://logs.test/in",
            http_content_format: "JSONOBJECT",
          },
        },
      ]),
    );
    await dest.deliver([dest.transform(makeEvent())]);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(Array.isArray(body)).toBe(false);
    expect(body.log_id).toBe("evt-1");
  });

  it("applies filter by log_type", async () => {
    const dest = new LogStreamDestination(
      makeStreams([
        {
          id: "lst_1",
          name: "filtered",
          type: "http",
          status: "active",
          sink: { http_endpoint: "https://logs.test/in" },
          filters: [{ type: "category", name: "fp" }],
        },
      ]),
    );
    await dest.deliver([dest.transform(makeEvent({ log_type: "sapi" }))]);
    expect(fetchMock).not.toHaveBeenCalled();

    await dest.deliver([dest.transform(makeEvent({ log_type: "fp" }))]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("merges http_custom_headers", async () => {
    const dest = new LogStreamDestination(
      makeStreams([
        {
          id: "lst_1",
          name: "custom",
          type: "http",
          status: "active",
          sink: {
            http_endpoint: "https://logs.test/in",
            http_custom_headers: [
              { header: "X-Source", value: "authhero" },
              { header: "X-Env", value: "prod" },
            ],
          },
        },
      ]),
    );
    await dest.deliver([dest.transform(makeEvent())]);
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["X-Source"]).toBe("authhero");
    expect(headers["X-Env"]).toBe("prod");
  });

  it("throws when sink response is not ok so outbox can retry", async () => {
    fetchMock.mockResolvedValueOnce(new Response("oh no", { status: 500 }));
    const dest = new LogStreamDestination(
      makeStreams([
        {
          id: "lst_1",
          name: "broken",
          type: "http",
          status: "active",
          sink: { http_endpoint: "https://logs.test/in" },
        },
      ]),
    );
    await expect(dest.deliver([dest.transform(makeEvent())])).rejects.toThrow(
      /500/,
    );
  });

  describe("firehose streams", () => {
    const FIREHOSE_SINK = {
      aws_region: "eu-north-1",
      delivery_stream_name: "authhero-logs",
      aws_access_key_id: "AKIDEXAMPLE",
      aws_secret_access_key: "secret",
    };

    function firehoseStream(
      sink: Record<string, unknown> = FIREHOSE_SINK,
    ): LogStream {
      return {
        id: "lst_fh",
        name: "firehose",
        type: "firehose",
        status: "active",
        sink,
      };
    }

    function firehoseOk(): Response {
      return new Response(
        JSON.stringify({
          FailedPutCount: 0,
          RequestResponses: [{ RecordId: "r-0" }],
        }),
        { status: 200 },
      );
    }

    async function sentRecords(): Promise<string[]> {
      const request = fetchMock.mock.calls
        .map(([input]) => input)
        .find(
          (input): input is Request =>
            input instanceof Request && input.url.includes("firehose."),
        );
      if (!request) throw new Error("no Firehose request");
      const body: { DeliveryStreamName: string; Records: { Data: string }[] } =
        JSON.parse(await request.clone().text());
      expect(body.DeliveryStreamName).toBe("authhero-logs");
      return body.Records.map((r) =>
        new TextDecoder().decode(decodeBase64(r.Data)),
      );
    }

    beforeEach(() => {
      fetchMock.mockImplementation(async (input: unknown) =>
        input instanceof Request ? firehoseOk() : new Response("ok"),
      );
    });

    it("sends the Auth0 log stream payload as one newline-terminated record", async () => {
      const dest = new LogStreamDestination(makeStreams([firehoseStream()]));

      await dest.deliver([dest.transform(makeEvent())]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [request] = fetchMock.mock.calls[0];
      expect(request.url).toBe("https://firehose.eu-north-1.amazonaws.com/");
      expect(request.headers.get("authorization")).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-north-1\/firehose\//,
      );
      // Not called as a method of the destination: workerd rejects that.
      expect(fetchMock.mock.contexts[0]).not.toBeInstanceOf(
        LogStreamDestination,
      );

      const [record] = await sentRecords();
      expect(record.endsWith("\n")).toBe(true);
      const payload = JSON.parse(record);
      expect(payload.log_id).toBe("evt-1");
      expect(payload.data.tenant_name).toBe("tenant-1");
      expect(payload.data.type).toBe("sapi");
    });

    it("omits the newline when newline_delimited is false", async () => {
      const dest = new LogStreamDestination(
        makeStreams([
          firehoseStream({ ...FIREHOSE_SINK, newline_delimited: false }),
        ]),
      );

      await dest.deliver([dest.transform(makeEvent())]);

      const [record] = await sentRecords();
      expect(record.endsWith("}")).toBe(true);
    });

    it("delivers to http and firehose streams side by side", async () => {
      const dest = new LogStreamDestination(
        makeStreams([
          {
            id: "lst_http",
            name: "loki",
            type: "http",
            status: "active",
            sink: { http_endpoint: "https://logs.test/in" },
          },
          firehoseStream(),
        ]),
      );

      await dest.deliver([dest.transform(makeEvent())]);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe("https://logs.test/in");
      expect(await sentRecords()).toHaveLength(1);
    });

    it("skips paused firehose streams and applies filters", async () => {
      const dest = new LogStreamDestination(
        makeStreams([
          { ...firehoseStream(), status: "paused" },
          {
            ...firehoseStream(),
            id: "lst_filtered",
            filters: [{ type: "category", name: "f" }],
          },
        ]),
      );

      await dest.deliver([dest.transform(makeEvent())]);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("throws on an unusable sink so the event is retried, not silently dropped", async () => {
      const dest = new LogStreamDestination(
        makeStreams([
          firehoseStream({ ...FIREHOSE_SINK, aws_secret_access_key: "" }),
        ]),
      );

      await expect(dest.deliver([dest.transform(makeEvent())])).rejects.toThrow(
        /lst_fh: AWS access key id and secret access key are required/,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("truncates details of an event over the 1,000 KiB record limit", async () => {
      const dest = new LogStreamDestination(makeStreams([firehoseStream()]));
      const event = makeEvent({
        request: {
          method: "PATCH",
          path: "/api/v2/users/user-1",
          ip: "127.0.0.1",
          body: { blob: "x".repeat(1100 * 1024) },
        },
      });

      await dest.deliver([dest.transform(event)]);

      const [record] = await sentRecords();
      expect(new TextEncoder().encode(record).length).toBeLessThanOrEqual(
        1000 * 1024,
      );
      const payload = JSON.parse(record);
      expect(payload.log_id).toBe("evt-1");
      expect(payload.data.details.request).toEqual({
        method: "PATCH",
        path: "/api/v2/users/user-1",
      });
      expect(payload.data.details.truncated).toBe(true);
      expect(payload.data.details.original_bytes).toBeGreaterThan(1000 * 1024);
    });

    it("skips an event still over the limit after truncation", async () => {
      const dest = new LogStreamDestination(makeStreams([firehoseStream()]));

      await dest.deliver([
        dest.transform(makeEvent({ description: "x".repeat(1100 * 1024) })),
      ]);

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});

describe("parseFirehoseSink", () => {
  const sink = {
    aws_region: "cn-north-1",
    delivery_stream_name: "s",
    aws_access_key_id: "id",
    aws_secret_access_key: "secret",
  };

  it("reads a complete sink, defaulting newline_delimited to true", () => {
    expect(parseFirehoseSink(sink)).toEqual({
      config: {
        target: {
          region: "cn-north-1",
          deliveryStreamName: "s",
          accessKeyId: "id",
          secretAccessKey: "secret",
        },
        newlineDelimited: true,
      },
    });
  });

  it("rejects a non-boolean newline_delimited and a bad region", () => {
    expect(parseFirehoseSink({ ...sink, newline_delimited: "no" })).toEqual({
      error: "newline_delimited must be a boolean",
    });
    expect(parseFirehoseSink({ ...sink, aws_region: "a.b/c" })).toHaveProperty(
      "error",
    );
  });
});
