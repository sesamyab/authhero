---
"authhero": minor
---

Add the Auth0-compatible Self-Service SSO Management API (#1763), mounted when the data adapter provides `selfServiceProfiles` and `ssoAccessTickets`:

- `GET/POST /api/v2/self-service-profiles`, `GET/PATCH/DELETE /api/v2/self-service-profiles/{id}`
- `GET/PUT /api/v2/self-service-profiles/{id}/custom-text/{language}/{page}`
- `POST /api/v2/self-service-profiles/{id}/sso-ticket`, which returns `{ "ticket": "<url>" }`
- `POST /api/v2/self-service-profiles/{profileId}/sso-ticket/{id}/revoke`, which returns `202`

Request bodies are parsed strictly. Auth0 fields AuthHero does not implement yet (`provisioning_config`, `use_for_organization_discovery`, `enabled_features`, `third_party_client_access_config`, `universal_logout_config`, `user_attribute_profile_id`, `connection_config.options.idpinitiated`, `domain_aliases_config.pending_domains`) and fields Auth0 does not define are rejected with `400` naming the field. Profiles and tickets accept the `oidc`, `samlp` and `waad` strategies. Tickets last 5 days by default and at most 30 days, and domain verification defaults to `required`. The ticket URL points at `/u2/self-service` on the tenant's domain. The setup screens come in a later release, so the URL does not open a page yet.
