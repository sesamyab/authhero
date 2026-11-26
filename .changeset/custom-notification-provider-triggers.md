---
"authhero": minor
"@authhero/adapter-interfaces": minor
---

Add Auth0's `custom-email-provider` and `custom-phone-provider` action triggers (issue #1797). An action bound to one of them delivers outgoing emails or text messages (one-time codes, magic links, verification, password reset and invitation emails, MFA SMS) from the tenant's own system. It receives Auth0's `event.notification`, and `api.notification.drop(reason)` and `api.notification.retry(reason)` work as in Auth0. Existing Auth0 actions run unchanged, and an email provider named `custom` sends all email through the action.

Two AuthHero extensions: the hook's `metadata.message_types` limits which message types the action handles (the rest keep using the tenant's normal provider; empty means all, as in Auth0), and `api.notification.useDefaultProvider()` hands a message back to the normal provider. Delivered messages are logged as before; drops and failures log `fn` and retries log `wn`. A failed, dropped or timed-out action fails the send instead of falling back silently. The one-time code and message content are scrubbed from logs, execution records and errors.
