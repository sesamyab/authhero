// Stand-in for https://developers.cloudflare.com/ai-gateway/usage/rest-api/
const http = require("node:http");

async function handle(req, res) {
  if (
    req.method !== "POST" ||
    req.url !== "/client/v4/accounts/test-account/ai/v1/chat/completions"
  ) {
    res.writeHead(501);
    return res.end("Endpoint not modeled");
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  if (
    req.headers.authorization !== "Bearer test-token" ||
    req.headers["cf-aig-gateway-id"] !== "test-gateway" ||
    req.headers["cf-aig-collect-log"] !== "false" ||
    req.headers["cf-aig-skip-cache"] !== "true" ||
    !body.model ||
    body.messages?.[0]?.role !== "system" ||
    !body.messages[0].content.includes("onExecutePostLogin") ||
    !body.messages[0].content.includes("type ActionAPI =") ||
    !body.messages[0].content.includes(
      "setCustomClaim(claim: string, value: unknown): void;",
    ) ||
    body.messages[1]?.role !== "user" ||
    body.stream !== false
  ) {
    res.writeHead(400);
    return res.end("Invalid gateway contract");
  }
  const prompt = body.messages[1].content;
  if (prompt === "upstream-error") {
    res.writeHead(503, { "content-type": "text/html" });
    return res.end("<html>sensitive-provider-details</html>");
  }
  if (prompt === "invalid-json") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end("not-json");
  }
  if (prompt === "hang")
    await new Promise((resolve) => setTimeout(resolve, 250));
  res.writeHead(200, { "content-type": "application/json" });
  return res.end(
    JSON.stringify({
      choices: [
        {
          finish_reason: prompt === "truncated" ? "length" : "stop",
          message: {
            role: "assistant",
            content:
              prompt === "empty"
                ? ""
                : "```javascript\nexports.onExecutePostLogin = async (event, api) => { api.idToken.setCustomClaim('role', 'reader'); };\n```",
          },
        },
      ],
    }),
  );
}

module.exports = handle;
if (require.main === module || typeof pm !== "undefined")
  http.createServer(handle).listen(process.env.PORT || 4500);
