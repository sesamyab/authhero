---
title: Who may do what
description: Authorization in AuthHero. APIs, scopes, roles and permissions, machine-to-machine access, and consent for third-party applications. Chapter 9 of the AuthHero Book.
---

<p class="book-kicker">Chapter 9 · Who may do what</p>

# Who may do what

Maya is logged in. We know who she is. That says nothing yet about whether she may delete the restaurant's entire stock list, which is a separate question with separate machinery.

## Three words that mean nearly the same thing

Authorization vocabulary is slippery, so here are the working definitions.

A **scope** is a string that names something a caller can be allowed to do. By convention it reads `action:thing`: `read:stock`, `write:stock`, `manage:billing`. Scopes are defined on an API, and they travel inside access tokens.

A **permission** is a scope that has been granted to a particular user. The API defines `write:stock`. Maya *has* `write:stock`.

A **role** is a named bundle of permissions. Nobody wants to hand out forty permissions one at a time, so you define *Cook* and *Manager* once and assign those.

Larder's setup might look like this:

| Role | Permissions on `https://api.larder.example` |
| --- | --- |
| Cook | `read:stock`, `write:stock` |
| Manager | `read:stock`, `write:stock`, `read:orders`, `write:orders` |
| Owner | All of the above, plus `manage:billing` |

## From request to token

When the web app starts a login, it asks for the scopes it would like: `scope=openid read:stock write:stock manage:billing`, along with `audience=https://api.larder.example`.

What happens next depends on one switch on the API, called **RBAC** for role-based access control.

With RBAC **off**, AuthHero grants whatever was asked for. That suits an API where every logged-in user may do everything, and it is the easiest way to get started.

With RBAC **on**, AuthHero compares the request with what the user actually holds:

| The requested scope is… | Result |
| --- | --- |
| A standard OpenID scope (`openid`, `profile`, `email`) | Always granted |
| Defined on the API, and the user has that permission | Granted |
| Defined on the API, and the user lacks it | Quietly left out |
| Not defined on the API at all | Passed through, by default |

Maya the cook asks for three API scopes and receives a token containing `read:stock write:stock`. The billing scope is simply absent. She does not get an error, because nothing went wrong. She just got the token she is entitled to.

The last row is the practical one. By default only scopes you *define* are restricted, so you can lock down the three sensitive operations and leave everything else alone. A tenant that prefers the strict reading can set the `restrict_undefined_scopes` flag, which drops undefined scopes whether RBAC is on or off.

A user's permissions are gathered from three places and combined: permissions given to them directly, roles assigned to them, and roles they hold inside an organization, which is the next chapter. Prefer roles to direct permissions. Direct grants are where "why can Dave still do that?" comes from two years later.

## The API has the last word

A token with the right contents does nothing unless the API checks it. Chapter 4 listed four checks that establish a token is genuine and meant for this API. Authorization is the fifth:

```ts
const { payload } = await jwtVerify(token, keys, { issuer, audience });

const granted = String(payload.scope ?? "").split(" ");
if (!granted.includes("write:stock")) {
  return new Response("Forbidden", { status: 403 });
}
```

The status codes carry meaning. `401` says *I do not know who you are*. `403` says *I know exactly who you are, and the answer is no*.

A note on token shape. By default the granted permissions appear in the `scope` claim, as above. An API can instead choose a second format that lists them in a separate `permissions` array. Pick one per API and have your code read the one you picked.

## Callers that are not people

The supplier sync job runs at three in the morning and no one is there to type a password. It still needs an access token.

For this there is the **client credentials** flow, the simplest in OAuth. The application presents its own credentials at the token endpoint and receives an access token. There is no browser, no user and no redirect.

```http
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials
&client_id=supplier-sync
&client_secret=…
&audience=https://api.larder.example
```

Because no user is involved, user roles do not apply. What a machine may ask for is set by a **client grant**: a record saying *this application* may obtain tokens for *this API* with *these scopes*. A machine with no grant for an API gets nothing.

A shared secret is the simplest way for an application to prove itself, but not the strongest, since AuthHero has to store a copy. An application can sign a short-lived statement with its own private key instead and register only the public half, so that nothing worth stealing sits on the server. This is the `private_key_jwt` method. It is worth the small extra effort for anything that guards money.

## Other people's applications

All of Larder's own applications are **first-party**. Maya trusts Larder, so when Larder's web app asks for access to Larder's API, there is nothing to ask her.

A **third-party** application is different. Say an accounting product wants to read Larder's orders on Maya's behalf. Now somebody else's software is asking for access to her data, and she should have a say. When an application is marked as third-party, AuthHero shows a **consent screen** listing what the application wants, and Maya can allow or refuse.

Her answer is remembered. The next time the same application asks for the same things, the screen does not appear. If it asks for something new, she is asked about the new part. The standard profile scopes never need consent. And a silent request can never widen what was agreed: it gets a `consent_required` error back instead.

Chapter 12 returns to third-party developers, and how they get an application registered in the first place.

## AuthHero follows its own rules

The Management API from chapter 2 is protected by exactly this model. It is an API with scopes such as `read:users`, `update:clients` and `create:roles`. Your admin user can use the dashboard because they hold a role that grants those permissions. A deployment script gets its token through client credentials with a client grant.

So you can apply the same discipline to your identity system as to everything else: a support tool that can read users but never delete them, and a CI job that can update one kind of setting and nothing more.

**In the docs:** [RBAC, Scopes & Permissions](/security/rbac) · [RBAC and Scopes Guide](/features/rbac-and-scopes) · [Resource Servers](/entities/security/resource-servers) · [Management API Security](/security/management-api) · [RFC 7523 (JWT client authentication)](/standards/rfc-7523)
