---
title: Tokens
description: ID tokens, access tokens and refresh tokens, what is inside them, how an API verifies them, and how long they live in AuthHero. Chapter 4 of the AuthHero Book.
---

<p class="book-kicker">Chapter 4 · The basics</p>

# Tokens

The login dance ends with the application holding up to three tokens. They look alike in a debugger and are routinely mistaken for each other, so it helps to think of them as three objects from a hotel.

- The **ID token** is the registration card. It says who checked in. It is for the front desk, which here is your application.
- The **access token** is the key card. It opens specific doors, and the doors do not care about your life story. It is for your API.
- The **refresh token** is the booking itself. Take it back to reception and you get a fresh key card without checking in again.

Mixing them up is the most common mistake in this whole area. An ID token sent to an API is a registration card held against a door lock. It might even be accepted if the API is careless, which is worse.

## What is inside

ID tokens and access tokens are **JWTs** (JSON Web Tokens, said "jots"). A JWT is three pieces of base64 text joined by dots: a header, a payload and a signature. Anyone can decode the first two. Here is the payload of an access token for Larder's API:

```json
{
  "iss": "https://auth.larder.example/",
  "sub": "auth0|6650f3a1c2",
  "aud": "https://api.larder.example",
  "iat": 1790000000,
  "exp": 1790086400,
  "scope": "openid read:stock write:stock",
  "org_id": "org_luigis"
}
```

Each field is called a **claim**.

| Claim | Meaning |
| --- | --- |
| `iss` | Issuer. Who signed this: your AuthHero tenant. |
| `sub` | Subject. The user ID. Use this as the account key, never the email address. |
| `aud` | Audience. Who the token is *for*. |
| `exp`, `iat` | When it expires and when it was issued, as Unix timestamps. |
| `scope` | What the holder may do. |
| `org_id` | Which customer company the user is acting for (chapter 10). |

An ID token has the same shape, but its audience is the application's client ID, and it carries profile claims such as `email`, `name` and `picture` instead of scopes.

Two things follow from the fact that anyone can read a JWT. First, never put a secret in one. Second, a token is only worth something because of the third part, the signature.

## Trusting a token without phoning home

AuthHero signs every token with a private key. The matching public keys are published at `/.well-known/jwks.json`. So an API can check a token on its own, without calling AuthHero on every request. That independence is the point of the design: your API keeps working at full speed, and AuthHero is not in the path of every call.

Verification is four checks, and skipping any one of them is a real vulnerability:

1. **The signature** matches one of the published keys. The token's header names the key with a `kid`.
2. **`iss`** is exactly your issuer, character for character, trailing slash included.
3. **`aud`** is *your* API's identifier. A valid token meant for some other API must be refused.
4. **`exp`** is still in the future.

In practice a library does this in a few lines:

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";

const keys = createRemoteJWKSet(
  new URL("https://auth.larder.example/.well-known/jwks.json"),
);

const { payload } = await jwtVerify(token, keys, {
  issuer: "https://auth.larder.example/",
  audience: "https://api.larder.example",
  algorithms: ["RS256"],
  requiredClaims: ["exp"],
});
```

The last option matters: the library checks `exp` when it is present, and that line makes a token without one fail. The library fetches the keys once, caches them, and looks again only when it meets a `kid` it has not seen, which is what makes key rotation painless. AuthHero can sign with RS256, ES256, ES384 or ES512. Pin the algorithms you expect, as above, and never take the token's own word for it.

Passing those four checks proves the token is genuine and meant for you. It does not yet prove the caller may do what they are asking. That is a fifth check, on `scope`, and chapter 9 is about it.

## Which API is this token for?

An application says which API it wants a token for by adding `audience=https://api.larder.example` to the `/authorize` request. AuthHero puts that value in `aud` and applies that API's rules to the token. If the request names no audience, the tenant's default audience is used.

It is a small parameter that people forget, and the symptom is always the same: the API rejects a token that looks perfectly healthy, because it was issued for something else.

## How long they live

Short-lived tokens limit the damage if one leaks. Long-lived tokens are convenient. The three tokens sit at different points on that line.

**Access tokens** last 24 hours by default. Each API can set its own lifetime, and an API that guards something sensitive should choose a much shorter one. Since APIs verify access tokens on their own, an access token cannot be taken back once issued. It simply runs out.

**ID tokens** are read once, at login, to learn who the user is. Their lifetime matters less.

**Refresh tokens** live longest, so they get the most machinery. They are not JWTs but opaque random strings, stored on the server side so they can be revoked. An application receives one when it asks for the `offline_access` scope. Each application configures two clocks for them:

- an **absolute** lifetime: the token dies after this long no matter what, and
- an **idle** lifetime: the token dies if it goes unused for this long.

Using a refresh token resets the idle clock and never extends the absolute one.

## Rotation: a tripwire for stolen tokens

A refresh token that works for 30 days is an attractive thing to steal. **Rotation** makes theft detectable. With rotation switched on for an application, every exchange returns a *new* refresh token and retires the old one.

Now suppose an attacker copies a refresh token from Maya's phone. Whoever uses it first gets a new one. When the other party shows up with the old, retired token, AuthHero knows that two holders exist. It cannot tell which is the thief, so it revokes the entire family of tokens, and Maya logs in again.

Real networks are untidy, so there is a short grace period, 30 seconds by default, in which presenting the previous token again is treated as a retry instead of an attack.

## Fresh facts and extra claims

Two last habits worth forming.

If you need current profile data, call `/userinfo` with the access token. What is printed in a token was true when it was issued, and a name changed five minutes ago will not be in it.

If you need extra information in a token, such as Maya's home restaurant, add a **custom claim**. Chapter 11 shows how. AuthHero lets you add claims but never overwrite the ones it owns: you cannot hand someone a different `sub`.

**In the docs:** [Tokens](/entities/security/tokens) · [Token verification](/features/authentication-flows#token-verification) · [Applications: refresh tokens](/entities/configuration/applications#refresh-tokens) · [RFC 7519 (JWT)](/standards/rfc-7519)
