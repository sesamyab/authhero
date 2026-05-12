---
"authhero": patch
---

Strip secret fields (`client_secret`, `app_secret`, `twilio_token`) from connection responses on the management API (GET list, GET by id, POST, PATCH). Matches Auth0's contract: secrets are write-only — callers POST/PATCH to set them, and an omitted value means "keep existing".
