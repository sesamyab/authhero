---
"authhero": patch
---

Management API user creation no longer runs signup validation (`disable_signup`, validate-registration hooks) when the token's `azp` names a client in the target tenant.
