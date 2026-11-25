import { describe, it, expect } from "vitest";
import { buildSink } from "./create";

describe("log stream create: buildSink", () => {
  it("sends only the firehose fields for a firehose stream", () => {
    expect(
      buildSink({
        type: "firehose",
        sink: {
          // Left over from first picking HTTP in the form.
          http_endpoint: "https://logs.example.com",
          aws_region: "eu-north-1",
          delivery_stream_name: "authhero-logs",
          aws_access_key_id: "AKIDEXAMPLE",
          aws_secret_access_key: "secret",
        },
      }),
    ).toEqual({
      aws_region: "eu-north-1",
      delivery_stream_name: "authhero-logs",
      aws_access_key_id: "AKIDEXAMPLE",
      aws_secret_access_key: "secret",
      newline_delimited: true,
    });
  });

  it("keeps an explicit newline_delimited: false", () => {
    expect(
      buildSink({ type: "firehose", sink: { newline_delimited: false } })
        .newline_delimited,
    ).toBe(false);
  });

  it("defaults the http content type and format", () => {
    expect(
      buildSink({ type: "http", sink: { http_endpoint: "https://x.test" } }),
    ).toEqual({
      http_endpoint: "https://x.test",
      http_authorization: undefined,
      http_content_type: "application/json",
      http_content_format: "JSONARRAY",
    });
  });
});
