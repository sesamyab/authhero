# Cloudflare Actions simulation

Created 2026-10-28 from the Cloudflare AI Gateway REST chat completions documentation.
The mock is maintained locally; owner mock discovery was skipped because the CLI
is signed out. Orbit discovery was attempted but unavailable through local DNS.

## Purpose

Exercise the real Cloudflare generator adapter over HTTP. The mock handler is in
`postman/mocks/cloudflare-action-generation/default.js`; the request and response
contract follows https://developers.cloudflare.com/ai-gateway/usage/rest-api/.

## Execution

Run from the repository root:

```sh
postman simulation run postman/simulations/cloudflare-actions.sim.yaml --port 4900 --output ndjson
CLOUDFLARE_AI_SIMULATION_URL=http://127.0.0.1:4900/cloudflare pnpm --filter @authhero/cloudflare-adapter test test/action-code-generator.spec.ts
```

## Assumptions

- The mock does not establish live model availability, Cloudflare token permissions,
  or generation quality (2026-10-28; limited to the HTTP test fixture).

## What didn't work

- 2026-10-28: Local port binding requires permission outside the execution sandbox.
- 2026-10-28: Postman's script wrapper does not satisfy `require.main === module`;
  the mock also starts its server when Postman's `pm` global is present.

## Observations

<!-- begin:observations -->
- 2026-10-28: Ten HTTP checks passed again after requiring API type declarations
  in the mock's request contract. The Cloudflare member received every request;
  the adapter checks also confirmed the exact trigger-specific declarations were
  included in the system prompt. Live Cloudflare was not contacted.
- 2026-10-28: Ten HTTP checks passed through the Cloudflare member; its request
  log showed successful responses, a 503 HTML response, malformed JSON, truncated
  and empty completions, and a delayed response for the timeout check. No other
  members exist. Live Cloudflare was not contacted.
<!-- end:observations -->
