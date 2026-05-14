---
"authhero": patch
---

Route email sends through the built-in provider matching `emailProvider.name`, and log notification failures to the audit log.

**Dispatch by provider name.** `sendEmail` now looks up `emailProvider.name` against a built-in service registry before falling back to the injected `ctx.env.data.emailService`. Currently the only built-in is `mailgun` (`MailgunEmailService`); anything else continues to delegate to the host application's `emailService` adapter as before. This matches the existing comment on `emailProviderSchema` ("The sending layer validates by `name`") and means a tenant that configures a mailgun provider no longer has its credentials parsed by an unrelated adapter (e.g. SES/SQS) and fail with a generic 500.

**Failure logging.** Both `sendEmail` and `sendSms` now wrap the underlying `.send()` call in a try/catch that:

- Emits `console.error` with tenant id, provider name, template, and recipient so the error is greppable in stdout.
- Writes a `LogTypes.FAILED_SENDING_NOTIFICATION` (`"fn"`) entry to the tenant's audit logs (`waitForCompletion: true`) including the provider name and error message.
- Re-throws the original error so existing error-handling behavior is preserved.

Previously a failing email/SMS provider produced a generic `Internal server error` response from the universal-login screen-api with no audit-log entry, making misconfigured providers hard to diagnose.
