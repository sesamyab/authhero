import { describe, it, expect } from "vitest";
import type { DataAdapters } from "@authhero/adapter-interfaces";
import { init } from "../../../src";
import createSamlpApi from "../../../src/routes/saml";

// The archive destinations validate their config in the constructor. They are
// built when the route apps are created, so a bad deployment config fails
// `init()` at startup instead of throwing from the outbox middleware's
// `finally` after a request's writes have already committed.
describe("archive destination config", () => {
  const badPipeline = {
    endpoint: "http://stream-1.ingest.cloudflare.com",
    token: "ingest-token",
  };

  it("rejects an invalid pipeline config when a route app is created", () => {
    expect(() =>
      createSamlpApi({
        dataAdapter: {} as DataAdapters,
        outbox: { enabled: true, pipeline: badPipeline },
      }),
    ).toThrow(/must use https/);
  });

  it("rejects an invalid pipeline config in init()", () => {
    expect(() =>
      init({
        dataAdapter: {} as DataAdapters,
        outbox: { enabled: true, pipeline: badPipeline },
      }),
    ).toThrow(/must use https/);
  });
});
