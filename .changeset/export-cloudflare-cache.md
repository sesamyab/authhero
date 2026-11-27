---
"@authhero/cloudflare-adapter": patch
---

Export `createCloudflareCache` and its `CloudflareCacheConfig` type again, so a Cache API `CacheAdapter` can be created on its own — for example for `@authhero/proxy`'s `createCacheAdapterHostCache` — without the custom-domain settings that `createAdapters` requires.
