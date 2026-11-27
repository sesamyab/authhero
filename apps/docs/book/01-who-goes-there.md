---
title: Who goes there?
description: What authentication is, why login grows into a product of its own, and where AuthHero fits. Chapter 1 of the AuthHero Book.
---

<p class="book-kicker">Chapter 1 · The basics</p>

# Who goes there?

Every application that keeps something for someone has to ask the same question before it hands anything over: who are you?

It starts small. Picture Larder, a little product that helps restaurants keep track of what is in the kitchen. Version one has a `users` table with an email and a password hash, a login form, and a cookie. It took an afternoon and it works.

Then the requests arrive. A cook forgets her password, so you build password reset. Someone signs up as `gordon@gmial.com`, so you build email verification. The owner would rather use his Google account. The mobile app needs to log in too, and the tablet on the kitchen wall has no keyboard. A supplier wants to push deliveries into your API. A restaurant chain will only sign the contract if their staff can log in through Okta, and if people who leave the company lose access the same day.

None of these is hard on its own. Together they are a product, and it is not the product you set out to build. It is also the part of your system where a small mistake costs the most.

This book is about that part: what it has to do, how the standard solutions work, and how AuthHero handles each of them. You can read it front to back. Later chapters build on earlier ones, and Larder comes along the whole way.

## Two questions, often confused

**Authentication** answers *who are you?* A password, a code sent to your phone, a fingerprint, a Google account: all of them are ways of proving an identity.

**Authorization** answers *what are you allowed to do?* A cook may count the stock. Only a manager may change the billing details.

The two get mixed up because they happen close together, but they fail in different ways. A broken authentication lets a stranger in. A broken authorization lets the right person do the wrong thing. Chapters 3 to 8 are about the first question, chapters 9 and 10 about the second.

## One place that knows who people are

The modern answer to the growing pile of login features is to move them out of the application into a service of their own: an **identity provider**.

The deal is simple. Your applications stop handling passwords altogether. When someone needs to log in, the application sends them to the identity provider. The provider does whatever it takes to be sure who they are, then sends them back with a signed statement saying so. The application checks the signature and gets on with its real job.

That gives you a few things at once:

- **One login for everything.** The web app, the mobile app and the admin tool all trust the same provider, so signing in once is enough.
- **One place to get security right.** Password storage, brute-force protection and multi-factor authentication are built a single time.
- **New ways to sign in without touching the apps.** Add passkeys or a customer's company login at the provider, and every application has it.

The signed statements are called **tokens**, and the rules for asking for them come from two standards you will meet constantly: **OAuth 2.0** and **OpenID Connect** (OIDC). Chapter 3 walks through them. For now it is enough to know that they are the common language. Any library that speaks it can talk to any provider that speaks it.

## Where AuthHero fits

AuthHero is an open-source identity provider. A few things set it apart.

**It speaks Auth0's dialect.** Beyond the standards, AuthHero implements the same APIs as Auth0, one of the most widely used hosted identity services. Auth0's client libraries and its Terraform provider work against AuthHero, usually by changing a domain name. Most code written for Auth0 Actions runs too, and chapter 11 lists the exceptions.

**It runs where you want it.** AuthHero is a library first. You can mount it inside an existing Node.js server, run it as a Docker container with a SQLite file, or deploy it to Cloudflare Workers or AWS Lambda. The same code runs on a laptop and at the edge.

**It keeps your data in your database.** The core never talks to a database directly. It talks to an adapter, and there are adapters for SQLite, Cloudflare D1, MySQL and DynamoDB. Your users live in storage you control.

**It is multi-tenant from the start.** One installation can serve many separate customers, brands or environments, each with its own users, settings and login page.

The code is dual-licensed: AGPL-3.0, or a commercial license if that does not suit you.

## Try it while you read

Nothing in this book requires a running server, but concepts stick better when you can poke at them. This gives you one on your own machine in about a minute:

```bash
npm create authhero@latest my-auth-app
cd my-auth-app
npm run dev
```

Or, without Node.js:

```bash
git clone https://github.com/markusahlstrand/authhero.git
cd authhero
docker compose up --build
```

[Getting Started](/getting-started) explains what each option sets up, and [Your First Login](/first-login) clicks through a complete login by hand.

Next, the vocabulary. Identity systems have a handful of nouns that everything else hangs on, and they are easier to learn all at once.
