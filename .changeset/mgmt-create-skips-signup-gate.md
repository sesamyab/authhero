---
"authhero": patch
---

Management API user creation no longer runs signup validation (`disable_signup`, validate-registration hooks) when the bearer token's `azp` names a client in the target tenant. Auth-flow signups are still validated. A `client_id` that did not come from a token and does not resolve in the tenant now fails with "Client not found" instead of silently skipping validation.
