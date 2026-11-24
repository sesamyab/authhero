import { describe, it, expect } from "vitest";
import { toLogStreamUpdate } from "./edit";

describe("log stream edit: toLogStreamUpdate", () => {
  it("leaves the sink alone so a blank header keeps the stored one", () => {
    expect(
      toLogStreamUpdate({
        name: "loki",
        clear_http_authorization: false,
        sink: { http_endpoint: "https://x.test" },
      }),
    ).toEqual({ name: "loki", sink: { http_endpoint: "https://x.test" } });
  });

  it("sends a null header when asked to remove it", () => {
    expect(
      toLogStreamUpdate({
        clear_http_authorization: true,
        sink: { http_endpoint: "https://x.test", http_authorization: "typed" },
      }),
    ).toEqual({
      sink: { http_endpoint: "https://x.test", http_authorization: null },
    });
  });
});
