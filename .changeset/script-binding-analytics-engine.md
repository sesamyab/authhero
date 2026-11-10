---
"@authhero/cloudflare-adapter": patch
---

`ScriptBinding` accepts `{ type: "analytics_engine"; name: string; dataset: string }`, so a Workers for Platforms tenant Worker can be given an Analytics Engine dataset through `extraBindings`. The upload already forwarded bindings as they were; only the type rejected this one.
