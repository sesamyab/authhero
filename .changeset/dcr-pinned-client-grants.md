---
"authhero": minor
---

Dynamic Client Registration only provisions a client grant when the Initial Access Token pins it. `audience` and `scope` in a `POST /oidc/register` body are accepted only when they repeat values pinned in the token's constraints, and otherwise return `400 invalid_client_metadata`. Open registration can no longer request API access. The Management API audience (and any `additionalManagementAudiences`) is never granted through registration, `/connect/start` or a minted Initial Access Token.

`/connect/start` consent on a tenant (not through the control-plane workspace picker) now requires the user to hold `create:clients` on the Management API at tenant level. Other users see an error instead of the confirm button.
