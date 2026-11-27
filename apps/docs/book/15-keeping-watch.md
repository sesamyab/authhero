---
title: Keeping watch
description: Operating AuthHero. Logs and audit events, log streams, attack protection, encryption at rest, signing keys and the standards it is tested against. Chapter 15 of the AuthHero Book.
---

<p class="book-kicker">Chapter 15 · Running it</p>

# Keeping watch

An identity system is the front door to everything else you run. Once it is in place, the work changes from building to watching. You need to know what happened, notice when someone is trying something, and make sure a bad day stays small.

## The first place to look: logs

Every login attempt leaves a record in the tenant's **logs**, whether it worked or not. So do sign-ups, password resets, token exchanges and failed hooks. Each entry says what happened, to whom, from which application, from which IP address, and when.

This is where every investigation starts. "Maya says she cannot log in" turns into a search for her email address. The log then tells you which of several quite different things is true: no user matched what she typed, the password was wrong, her account is blocked, or the login actually succeeded and the problem is in the application.

That distinction matters because the login page itself is deliberately vague. It says "wrong email or password" for both of the first two cases, so that the page cannot be used to discover which accounts exist. The log is where the precise answer lives, for people allowed to read it.

Logs are in the admin dashboard and at `GET /api/v2/logs`. With a location adapter configured, entries also carry the city and country a request came from. Daily totals of logins and sign-ups, and counts of active users, are available as statistics.

## Who changed what

Logins are one kind of history. Changes to the configuration are another, and after an incident it is usually the more interesting one. Who removed MFA from that account? When did this application's callback URL change, and what was it before?

AuthHero records an **audit event** for every change made through the Management API: who made it, what was affected, and the state before and after, with secrets blanked out.

With the outbox from chapter 11 enabled, an audit event is written in the same database transaction as the change it describes. Either both exist or neither does. A crash at the wrong moment cannot leave you with a change and no record of it.

## Sending it elsewhere

Your security team already has a place where logs go. A **log stream** forwards every event there as it happens.

There are two kinds. An HTTP stream posts each event to a URL in the same format Auth0 uses, which Datadog accepts directly and Splunk accepts through a small relay. A Firehose stream delivers to Amazon Data Firehose, and from there to S3, OpenSearch or wherever else you archive things.

Streams are delivered through the outbox, so a destination that is down for an hour receives its events when it comes back.

## When someone is trying

Any login page on the internet is under constant low-grade attack, mostly from lists of leaked passwords being tried against every site in turn. AuthHero has two defenses, set per tenant.

**Brute-force protection** watches each account. After three failed passwords within five minutes, password logins for that account are refused. The count lives with the user record, so it works on every deployment with nothing extra to set up. A successful login or a password reset clears it.

**Suspicious IP throttling** watches each source address, to stop one machine trying one password against ten thousand accounts. It needs a rate limiter, which on Cloudflare is a built-in platform feature and elsewhere is an adapter you provide. Trusted addresses can be put on an allowlist.

If the rate limiter itself breaks, AuthHero lets requests through. A security feature that locks everyone out when it malfunctions is an outage of your own making.

Beyond these two, the highest-value protection is the one from chapter 7. An attacker holding the right password is still stopped by a second factor.

## If the database leaks

Assume that one day someone reads your database who should not: a stolen backup, a misconfigured replica, an injection bug in something that shares the server. What do they get?

**Passwords** are stored only as bcrypt hashes, so not those.

**Secrets that have to be read back** are a harder problem. Google's client secret for your social connection cannot be hashed, because AuthHero has to present it to Google. For these there is **encryption at rest**. You supply a key through the environment, wrap the adapter, and the sensitive fields are encrypted before they reach the database: client secrets, connection secrets, email provider credentials, authenticator secrets and Action secrets.

```ts
const key = await loadEncryptionKey(process.env.ENCRYPTION_KEY);
const dataAdapter = createEncryptedDataAdapter(createAdapters(db), key);
```

This is the stacking of adapters from the last chapter, doing real work. It protects against someone who can read the database but cannot read the running application's memory, and that describes most real leaks. It is off until you turn it on, and existing values are encrypted as they are next written.

**Refresh tokens, session transfer tokens and remembered devices** are stored as hashes, so a database dump does not hand over working credentials.

## The keys that sign everything

Every token is trusted because of a signature, so the signing keys are the most valuable thing in the system.

Keys are **rotated** by adding a new one alongside the old. Both are published at the JWKS address during the changeover, which is why chapter 4 told you to look keys up by their ID instead of assuming there is only one. APIs that follow that advice notice nothing. A key can also be revoked at once if you believe it has been exposed.

In a deployment with many tenants and custom domains, a subtler problem appears. An API receives a token whose issuer is `login.luigis.example`. Is that really one of your tenants, or a domain an attacker set up yesterday? AuthHero can issue each signing key a certificate from a certificate authority that you control, naming the tenant it belongs to. An API then needs to trust only your one root certificate, and can check any tenant's tokens without keeping a list of every valid domain.

## How you know it is correct

A reasonable question to ask of any identity provider: how do you know it implements the standards properly?

AuthHero is tested against the **OpenID Foundation's conformance suite**, the official set of tests an OpenID provider is expected to pass. An automated runner drives the suite against a real AuthHero server, logging in through real browser pages.

The documentation also keeps a plain list of every specification AuthHero touches, each marked *full*, *partial* or *planned*, including what is missing from the partial ones. In a product that guards the front door, knowing exactly where the edges are is worth more than a long feature list.

## A short checklist

For the day before you go live:

- The issuer URL is final. It is baked into every token.
- Retention is scheduled (chapter 14).
- Brute-force protection is on, and IP throttling too if you have a rate limiter.
- Encryption at rest is enabled, with the key in a secrets manager.
- Logs are streaming somewhere that outlives the database.
- MFA is required for everyone who can use the Management API.
- Applications that do not need a refresh token do not ask for one, and those that do have rotation on.
- Someone knows how to block a user and revoke a session at three in the morning.

**In the docs:** [Audit Logging](/features/audit-logging) · [Log Stream Recipes](/features/log-streams-recipes) · [Troubleshooting](/troubleshooting) · [Rate limiting and attack protection](/api/overview#rate-limiting) · [Encryption at Rest](/security/encryption-at-rest) · [Signing-key Certificates](/security/signing-key-certificates) · [Standards](/standards/) · [Conformance Testing](/standards/conformance)
