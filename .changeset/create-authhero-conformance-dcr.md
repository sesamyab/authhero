---
"create-authhero": patch
---

Enable `enable_dynamic_client_registration` on the conformance tenant when `--conformance` is set. The flag is required by the new `oidcc-dynamic-certification-test-plan` runner — without it, the conformance suite's `POST /oidc/register` calls fail because the tenant doesn't advertise a `registration_endpoint`. Existing tenant flags (e.g. `inherit_global_permissions_in_organizations` set by seed for the control-plane tenant) are preserved by reading the tenant first and merging.
