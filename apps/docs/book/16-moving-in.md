---
title: Moving in
description: Migrating to AuthHero from Auth0 or from a login system of your own, what to expect to differ, and where to go next. The final chapter of the AuthHero Book.
---

<p class="book-kicker">Chapter 16 · Running it</p>

# Moving in

Very few teams start from nothing. There is already a login, and already users, and those users have passwords you cannot read and sessions you would prefer not to break. The last chapter is about getting from there to here without anyone outside the team noticing.

## Coming from Auth0

This is the route AuthHero was designed for, and it shows in how little has to change.

**Your applications.** Auth0's client libraries keep working. In most cases the migration of an application is one line: the domain it points at.

**Your configuration.** Applications, connections, APIs, roles and organizations have the same names and the same JSON shapes on both sides. If you manage Auth0 with Terraform or the Management API, the same tooling can populate AuthHero.

**Your custom logic.** Actions use the same format. Chapter 11 listed the limits to check: there is a five-second timeout, npm packages are not loaded, and post-login Actions do not run again on a token refresh.

That leaves the hard part, which is the users. There are two ways to bring them over, and they work well together.

### Let them migrate themselves

**Lazy migration** moves users one at a time, at the moment each of them next shows up.

You point your applications at AuthHero and give AuthHero credentials for the old Auth0 tenant. When Maya logs in and AuthHero has never heard of her, it quietly checks her password against Auth0. If Auth0 accepts it, AuthHero creates her account, stores a hash of the password she just typed, and completes the login. From then on she is an AuthHero user, and Auth0 is not consulted again.

The same idea covers people who are already logged in. When an application presents a refresh token that Auth0 issued, AuthHero redeems it with Auth0 one last time, creates the user, and hands back a refresh token of its own. The application has no idea anything happened.

What makes this attractive is everything it avoids. There is no export of password hashes, no forced password reset, no "we have upgraded our systems" email, and no cutover night. Active users move within days. The long tail moves whenever they return.

### Or bring them all at once

**Bulk import** loads a file of users through the same jobs API that Auth0 has. If you can obtain your password hashes, and they are bcrypt, they are imported as they are and users log in with their existing passwords. Rows with a hash AuthHero cannot verify are reported individually, and the rest of the file still goes in.

A common combination is to import everyone's profile in bulk, so that the user list is complete from day one, and leave lazy migration switched on to pick up the passwords.

### What will be different

Compatibility is deep, but it is not total, and it is better to hear this from the book than from production.

| Area | What to expect |
| --- | --- |
| Hosting | You run it. There is no hosted service to call when it is down at night. |
| Company logins | OpenID Connect, OAuth 2.0 and SAML connections. No LDAP or Active Directory connections, and SAML logins cannot start from the company's portal. |
| MFA | No risk-based "adaptive" mode. Push notifications are not among the factors. |
| Actions | A code executor must be configured. See the limits above. |
| Refresh token errors | An invalid refresh token returns `400`, as the standard says, where Auth0 returns `403`. |
| Access tokens | Always JWTs issued for an audience. Send one, or set a default on the tenant. |
| Certifications | AuthHero is software, not an audited service. Compliance is assessed on your deployment. |

And some things you gain: tenants without an enterprise plan, hooks before and after a user is deleted, organization switching on a refresh token, and no charge per active user.

## Coming from your own login

If the starting point is a `users` table of your own, the same two tools apply, with one addition.

**Bulk import** works if your hashes are bcrypt. If they are something else, users will need to set a new password, and a password reset ticket (chapter 10) makes that a single link in an email instead of a hunt through the forgot-password flow.

**Custom token exchange** from chapter 12 lets the two systems run side by side. Your existing login keeps working and vouches for its users, so new services can rely on AuthHero tokens from the first day. You can then move login itself across later, one application at a time. For a system with years of history, this is usually the least frightening order to do things in.

## Is it the right fit?

A book about a product should say when to choose something else.

AuthHero fits well when you want to own your identity system: the code, the data, where it runs and what it costs as you grow. It fits when you need many tenants, when you want login to run at the edge close to your users, and when you want the option of changing any part of it.

A hosted identity service fits better when you would rather not operate this at all, when you need a vendor's compliance certificates on day one, or when you depend on a connection type from the table above.

Because AuthHero speaks the same protocols and the same API dialect, the decision is not a trapdoor in either direction.

## Where to go from here

You now have the whole map. A login is a short dance of redirects that ends in tokens. Tokens are signed statements that an API can check by itself. A session behind them makes one login serve many applications. Connections decide how people prove who they are, and a second factor backs that up. Scopes, roles and organizations decide what they may do once inside. And your own rules can be attached at every step.

The rest is detail, and the reference documentation is where the detail lives:

- **Run it.** [Getting Started](/getting-started), then [Your First Login](/first-login).
- **Understand the pieces.** [Architecture](/architecture/) and [Entities](/entities/).
- **Build a feature.** The [Features](/features/) section has a guide for each one in this book.
- **Put it in production.** [Deployment](/deployment/) and the [Security Model](/security/).
- **Migrate.** The [Auth0 Comparison](/auth0-comparison/) section, starting with [Lazy Migration](/auth0-comparison/lazy-migration).
- **Check a detail.** The [API Reference](/api/overview) and the [Standards](/standards/) pages.

Maya, for what it is worth, never thinks about any of this. She opens the app, she is recognised, and she counts the tomatoes. When login works, nobody notices it, and that is how you know it does.
