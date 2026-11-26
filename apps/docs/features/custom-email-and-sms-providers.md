---
title: Custom Email and SMS Providers
description: Deliver AuthHero's emails and text messages from your own system with Auth0-compatible custom-email-provider and custom-phone-provider Actions.
---

# Custom Email and SMS Providers

AuthHero sends one-time codes, magic links, verification and password reset
emails, invitations and MFA text messages. By default they go out through the
tenant's [email provider](./email-templates.md) or SMS connection. With a
**custom provider Action**, your own code delivers them instead, for example
through your own messaging service, a queue, or a provider AuthHero doesn't
support.

AuthHero implements Auth0's two triggers, so an Action written for Auth0 runs
unchanged:

| Trigger                 | Handler                        | Delivers                     |
| ----------------------- | ------------------------------ | ---------------------------- |
| `custom-email-provider` | `onExecuteCustomEmailProvider` | Emails                       |
| `custom-phone-provider` | `onExecuteCustomPhoneProvider` | Text messages, including MFA |

Auth0 references:
[custom email provider](https://auth0.com/docs/customize/email/smtp-email-providers/custom/configure-action),
[custom phone provider API object](https://auth0.com/docs/customize/phone-messages/configure-phone-messaging-providers/configure-a-custom-phone-provider/action-triggers-custom-phone-provider-api-object).
The MFA-only [`send-phone-message` trigger](https://auth0.com/docs/customize/actions/explore-triggers/mfa-notifications-trigger)
is not supported. Auth0 itself recommends `custom-phone-provider` for custom
phone providers.

## Turning it on

Bind an enabled Action to the trigger, either on the **Triggers** page of the
admin UI or with the Management API:

```http
PATCH /api/v2/actions/triggers/custom-email-provider/bindings
{ "bindings": [{ "ref": { "type": "action_id", "value": "act_123" } }] }
```

That's all. Your email provider and SMS connection don't change, and with
nothing bound every message goes out exactly as before.

For Auth0 tooling compatibility, an email provider named `custom`
(`{ "name": "custom", "credentials": {} }`, as Auth0's Terraform provider sets it)
sends **all** email through the Action. If no Action is bound, the send fails
with a logged error, because there is no other provider to fall back to.

## The event

### `custom-email-provider`

```javascript
exports.onExecuteCustomEmailProvider = async (event, api) => {
  const { to, from, subject, html, text, locale, message_type } =
    event.notification;
  const response = await fetch("https://mail.example.com/send", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${event.secrets.API_KEY}`,
    },
    body: JSON.stringify({ to, from, subject, html, text }),
  });
  if (response.status >= 500) {
    api.notification.retry(`Mail API returned ${response.status}`);
  } else if (!response.ok) {
    api.notification.drop(`Mail API returned ${response.status}`);
  }
};
```

`event.notification` has `to`, `from`, `subject`, `html` (rendered from your
[email templates](./email-templates.md)), `text` (a plain-text version of the
HTML), `locale` and `message_type`:

| `message_type`                     | Sent when                                     |
| ---------------------------------- | --------------------------------------------- |
| `verification_code`                | passwordless login code or magic link         |
| `verify_email`                     | email verification link (including pre-signup) |
| `verify_email_by_code`             | email verification code                       |
| `reset_email`                      | password reset link                           |
| `reset_email_by_code`              | password reset code                           |
| `organization_invitation`          | organization invitation                       |
| `try_provider_configuration_email` | "Send test email" in the admin UI             |

Auth0's other values (`welcome_email`, `mfa_oob_code`, `enrollment_email`,
`blocked_account`, `stolen_credentials`) are accepted in configuration but
AuthHero doesn't send those messages yet.

### `custom-phone-provider`

```javascript
exports.onExecuteCustomPhoneProvider = async (event, api) => {
  const { recipient, as_text, code, message_type } = event.notification;
  await fetch("https://sms.example.com/messages", {
    method: "POST",
    headers: { authorization: `Bearer ${event.secrets.API_KEY}` },
    body: JSON.stringify({ to: recipient, text: as_text }),
  });
};
```

`event.notification` has `recipient`, `from`, `as_text`, `as_voice`, `code`,
`delivery_method` (always `text` today), `locale` and `message_type`:

| `message_type` | Sent when                                         |
| -------------- | ------------------------------------------------- |
| `otp_verify`   | passwordless SMS code or link, MFA SMS challenge  |
| `otp_enroll`   | MFA SMS enrollment                                |

Both triggers also get `event.tenant`, `event.client`, `event.request`,
`event.secrets` and, when the sender knows the user, `event.user`.

## The API

Do nothing to report the message as delivered. Otherwise call one of these;
if you call several, the last call wins (as in Auth0):

- **`api.notification.drop(reason)`**: delivery failed and shouldn't be
  retried. The message is not sent and a `fn` (Failed Sending Notification) log
  is written with the reason. The user sees that sending failed.
- **`api.notification.retry(reason)`**: delivery failed but may work later.
  A `wn` (Warning Sending Notification) log is written, the flow continues as if
  the message was sent, and AuthHero runs the Action again in the background up
  to 5 times (after 1, 2, 3, 5 and 8 seconds). If every retry fails, an `fn` log
  is written. The user can still use "resend".
- **`api.notification.useDefaultProvider()`** *(AuthHero extension)*: send this
  message with the tenant's normal email provider or SMS connection instead.

Reasons are limited to 1024 characters.

`api.cache` is not supported yet.

## Choosing which messages the Action delivers

*AuthHero extension, inspired by Clerk's per-template "Delivered by Clerk"
switch.*

A binding can be limited to some message types. The other messages keep going
through the email provider or SMS connection. In the admin UI, edit the binding
and pick **Message types delivered by this action**. With the Management API,
set the hook's `metadata.message_types`:

```http
PATCH /api/v2/hooks/{hook_id}
{ "metadata": { "message_types": ["verification_code", "reset_email_by_code"] } }
```

Leave the list empty (the default) to deliver every message, which is Auth0's
behaviour. If several Actions are bound, the highest-priority enabled one whose
list includes the message type handles it. Replacing a trigger's bindings
through `PATCH /api/v2/actions/triggers/{id}/bindings` recreates the hooks, so
the selection is reset to "every message".

## Failures

- An Action that **throws**, **times out** (5 seconds), calls **`drop()`** or
  can't run (no code executor, code not found) fails the send the same way a
  provider error does. The user sees "couldn't send", for example on the
  MFA resend screen, rather than waiting for a code that never comes. An `fn` log
  is written. AuthHero **never** falls back to the normal provider on its own. If
  you want a fallback, call `api.notification.useDefaultProvider()` from your
  Action's error handling.
- Existing rate limits, such as the per-session MFA SMS limit, are checked before
  the Action runs. Background retries don't count against them.

## Logs and secrecy

Messages delivered by an Action are logged exactly like normal sends (for
example `cls` for passwordless codes and `gd_send_sms` for MFA SMS), so support
can still see that a code was sent. Each run is also stored as an Action
execution (`GET /api/v2/actions/executions/{id}`).

The one-time code and the message content never reach tenant logs, the outbox,
execution records or error messages. Before anything the Action reports back
(console output, thrown errors, drop and retry reasons) is stored, AuthHero
replaces the code, tokenized links and the rendered content with `[REDACTED]`.
It withholds any value that still contains a fragment of the message. Log the
message ID your own system returns, not the message.

## Limits

- Code Actions only. Webhooks, forms and the `init()` config callbacks can't
  bind to these triggers.
- Background retries run in the request's background window (about 30 seconds
  on Cloudflare Workers) rather than over several minutes as on Auth0. The
  message is kept in memory only and is never written anywhere for a retry.
- Voice delivery (`delivery_method: "voice"`) is not used yet.
