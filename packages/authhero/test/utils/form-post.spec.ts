import { describe, it, expect } from "vitest";
import { formPostResponse } from "../../src/utils/form-post";

describe("formPostResponse", () => {
  it("returns a 200 HTML page that POSTs to the redirect_uri", async () => {
    const res = formPostResponse(
      "https://rp.example/cb",
      { code: "abc123", state: "xyz" },
      new Headers(),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = await res.text();
    expect(body).toContain('method="post"');
    expect(body).toContain('action="https://rp.example/cb"');
    expect(body).toContain('name="code" value="abc123"');
    expect(body).toContain('name="state" value="xyz"');
    expect(body).toContain("document.forms[0].submit()");
  });

  it("HTML-escapes attacker-controlled values to prevent XSS", async () => {
    const res = formPostResponse(
      'https://rp.example/cb"><script>alert(1)</script>',
      {
        state: '"><script>alert(2)</script>',
        code: "<img src=x onerror=alert(3)>",
      },
      new Headers(),
    );

    const body = await res.text();
    // The attacker can't break out of the attribute (quote escaped) or
    // introduce a new tag (`<` escaped). Strings like `onerror=alert` may
    // still appear as inert text inside an escaped attribute value, which
    // is harmless — the browser doesn't parse them as event handlers when
    // the surrounding `<` is encoded.
    expect(body).not.toContain("<script>alert");
    expect(body).not.toContain('"><script>');
    expect(body).toContain("&lt;script&gt;");
    expect(body).toContain("&quot;&gt;");
  });

  it("preserves caller-supplied headers (e.g. set-cookie)", () => {
    const headers = new Headers();
    headers.append("set-cookie", "sid=abc");
    const res = formPostResponse(
      "https://rp.example/cb",
      { code: "x" },
      headers,
    );
    expect(res.headers.get("set-cookie")).toBe("sid=abc");
  });

  it("emits no-script fallback so users without JS can complete the flow", async () => {
    const res = formPostResponse(
      "https://rp.example/cb",
      { code: "x" },
      new Headers(),
    );
    const body = await res.text();
    expect(body).toContain("<noscript>");
    expect(body).toContain('type="submit"');
  });
});
