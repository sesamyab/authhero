// OAuth 2.0 Form Post Response Mode (https://openid.net/specs/oauth-v2-form-post-response-mode-1_0.html)
// Renders the authorization response as an HTML page that auto-submits a POST
// form to the redirect_uri. Same parameter set as query/fragment; just delivered
// as an `application/x-www-form-urlencoded` POST body.

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

export function formPostResponse(
  redirectUri: string,
  params: Record<string, string>,
  headers: Headers,
): Response {
  const inputs = Object.entries(params)
    .map(
      ([k, v]) =>
        `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}" />`,
    )
    .join("\n      ");

  const html = `<!DOCTYPE html>
<html>
<head><title>Submit This Form</title></head>
<body onload="document.forms[0].submit()">
  <noscript>
    <p>JavaScript is disabled. Click the button to continue.</p>
    <button type="submit" form="formpost">Continue</button>
  </noscript>
  <form id="formpost" method="post" action="${escapeHtml(redirectUri)}">
      ${inputs}
  </form>
</body>
</html>`;

  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("pragma", "no-cache");
  return new Response(html, { status: 200, headers });
}
