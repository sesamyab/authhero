---
title: Teams and companies
description: Organizations in AuthHero for business customers. Membership, per-company roles, invitations, company single sign-on, SCIM provisioning and SAML. Chapter 10 of the AuthHero Book.
---

<p class="book-kicker">Chapter 10 · Who may do what</p>

# Teams and companies

Larder does not really sell to cooks. It sells to restaurants. Luigi's is a customer. Noodle Bar, a chain with forty locations, is a customer. Each has staff, and what a person may do depends on which restaurant they are acting for.

That is the business-to-business shape, and the roles from the last chapter are not enough for it. A role is global. If Maya is a *Manager*, she is a manager everywhere. But Maya manages Luigi's, and on Tuesdays she covers a shift at Noodle Bar, where she should only be able to count stock.

## Organizations

An **organization** is a customer company inside your tenant. It has:

- **Members**: users who belong to it. One user can belong to several.
- **Roles per member**: Maya is *Manager* at Luigi's and *Cook* at Noodle Bar.
- **Its own look**, so that a company's staff see their own logo when they log in.

When an application starts a login, it can say which company the user is acting for by adding `organization=org_luigis` to the `/authorize` request. AuthHero checks that the user is a member (a non-member is refused) and issues tokens that carry the context:

```json
{
  "sub": "auth0|6650f3a1c2",
  "org_id": "org_luigis",
  "org_name": "luigis",
  "scope": "openid read:stock write:stock read:orders write:orders"
}
```

The scopes are the ones Maya's role *at Luigi's* gives her. A token for Noodle Bar would contain less.

Your API then has one more check to make, and it is the one that keeps customers out of each other's data: does the `org_id` in the token match the organization that owns the thing being asked for?

```ts
if (payload.org_id !== stockList.organizationId) {
  return new Response("Forbidden", { status: 403 });
}
```

## Switching hats

Maya should not have to log out and in again to change restaurants. Her application can swap the organization on a refresh token exchange:

```http
POST /oauth/token

grant_type=refresh_token
&refresh_token=…
&client_id=larder-web
&organization=org_noodlebar
```

Back come tokens for the other organization, with the roles she holds there. Leave the parameter out and the tokens stay with the organization she logged in to.

## Getting people in: invitations

A manager at Luigi's hires a new cook. Nobody at Larder should have to be involved.

An **invitation** is created through the Management API, by your own app on the manager's behalf. It names the invitee's email address, the organization, and the roles they will get. AuthHero emails a link. The new cook follows it, sets up a login, and lands in the application as a member of Luigi's with the right role already in place. Invitations expire after seven days unless you choose another period, up to thirty.

The same family of one-time links also covers two related chores. A **ticket** can verify a user's email address, or let them choose a new password without knowing the old one.

## When the customer is a big company

Small restaurants are happy with invitations. Noodle Bar has an IT department, and IT departments ask for three specific things.

### "Our people log in with our login"

This is the enterprise connection from chapter 6. Noodle Bar's Okta or Microsoft Entra ID becomes a connection, their email domain is listed on it, and home realm discovery sends anyone with a `@noodlebar.example` address to the company's own login page. Noodle Bar's password rules and MFA apply, and Larder never holds a password for these users.

Many company directories speak OpenID Connect. Plenty still speak only **SAML**, its XML-based predecessor, which remains common in enterprise software. AuthHero has a connection type for that too. You hand it the address of the company's SAML metadata, and it reads the login address and signing certificates from there. Every response that comes back is checked against those certificates before anyone is let in, which is why a deployment that uses SAML connections has to be started with a signature verifier. Two limits to know: the login has to start at AuthHero, not from a tile in the company's portal, and encrypted assertions are not accepted.

### "When someone leaves, they must lose access today"

Company login covers half of this: a departed employee can no longer log in. But their Larder account still exists, and a refresh token on a phone may still work.

**SCIM** closes the gap. It is a standard that lets the company's directory push changes to you. Noodle Bar's IT points Okta or Entra at an address AuthHero provides for their connection, authenticated with a token only they hold. From then on:

- a new hire assigned to Larder in the directory becomes a user in AuthHero, before their first login
- a change of name or email follows automatically
- a deactivation marks the user as **blocked**, which, as chapter 5 described, refuses every login and revokes every session and refresh token on the spot

AuthHero's SCIM support covers users. Pushing groups is not supported yet.

### "Can we use Larder as a login for our other tools?"

Sometimes the direction reverses. A customer, or one of your own teams, runs an older tool that only understands SAML, and wants its users to sign in with their Larder login.

AuthHero can also act as a **SAML identity provider**. You register the tool as an application with the SAML add-on, give the tool AuthHero's metadata URL, and it can send users to AuthHero to log in and get back a signed SAML assertion. Users log in the same way they always do, and the old tool joins the single sign-on.

So SAML works in both directions. A SAML *connection* lets people into AuthHero through someone else's identity provider. The SAML *add-on* lets AuthHero be the identity provider for someone else's application.

## People who work across every company

Larder's own support staff need to open any customer's account, and they are not members of any of them. Adding them to every organization would be tedious and error-prone.

AuthHero has two ways around membership, both deliberate and narrow. A tenant can let global roles apply inside organizations. And one specific permission, `access:all_organizations`, lets a user obtain a token for any organization while carrying only the scopes of their own global role. Give it to few people and audit who has it.

## Organization or tenant?

Both divide users into groups, so it is fair to ask which to use.

**Organizations** share one user pool and one configuration. A person can belong to several, your applications are the same for all of them, and you manage everything in one place. This is right for the customers of one product.

**Tenants** share nothing. Each has separate users, separate applications, separate connections, separate signing keys and a separate login page. This is right when the groups must not know about each other: different products, different brands, or customers who are themselves building products on top of you.

Most business software wants one tenant with many organizations. Chapter 13 is about the cases that need more.

**In the docs:** [Organizations](/entities/identity/organizations) · [Invitations & Tickets](/features/invitations-and-tickets) · [SCIM Provisioning](/features/scim-provisioning) · [SAML Connections](/customization/saml/connections) · [SAML 2.0](/standards/saml-2) · [Multi-Tenancy & Organizations](/security/multi-tenancy)
