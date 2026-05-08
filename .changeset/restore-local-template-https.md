---
"create-authhero": patch
---

Restore HTTPS support to the `local` template's `src/index.ts`. The `ensureCertificates()` block (mkcert/openssl self-signed cert generation) and the `createServer: https.createServer` wiring were inadvertently removed in an earlier change, leaving generated auth-servers HTTP-only. The conformance-runner pipeline depends on HTTPS so its discovery checks (e.g. `CheckDiscEndpointAllEndpointsAreHttps`) can pass.
