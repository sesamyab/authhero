---
title: Ways to sign in
description: Passwords, one-time codes, magic links, social logins, company logins and passkeys, and how AuthHero keeps one person as one account across all of them. Chapter 6 of the AuthHero Book.
---

<p class="book-kicker">Chapter 6 · Signing in</p>

# Ways to sign in

So far Maya "proved who she was" and we moved on. There are many ways to do that, each with its own strengths, and AuthHero models every one of them the same way: as a **connection**.

A connection is a source of identity. A tenant can have as many as it needs, and each application picks the ones it wants on its login page, in the order it wants them shown. Add a connection to an application and the next person to open its login page sees the new option. The application's code does not change.

## Passwords

The oldest method, and still the one people expect. In AuthHero it is called a **database connection**, because AuthHero itself stores the credentials. A new tenant comes with one, named `Username-Password-Authentication`.

A password login is really a bundle of features, and all of them are in the box:

- **Sign-up**, with rules you can add about who may register (chapter 11).
- **Email verification**, by a six-digit code or by a link. You choose per connection. An application can insist that the email is verified before a login completes.
- **Password reset**, also by code or by link.
- **Brute-force protection.** After three wrong passwords within five minutes, password logins for that account are temporarily refused. Other methods, such as a code by email, still work, so the real owner is not locked out by someone else's guessing.

Passwords are stored as bcrypt hashes. AuthHero cannot tell you what anybody's password is, which is how it should be.

## Codes and links: passwordless

A password is a secret the user has to invent, remember and keep to themselves. Most people are not good at all three. **Passwordless** login skips the secret. Maya types her email address, and AuthHero sends her either a short code to type in or a **magic link** to click. Being able to read that inbox is the proof.

The same works over SMS with a phone number. There is no password to forget, reuse or phish, and sign-up and login become the same motion. For many products this is the best default.

The trade-off is that login now depends on message delivery. AuthHero sends email and text messages through providers you configure, or hands them to your own code if you use a service it does not know about.

## Somebody else's login: social

"Continue with Google" is the authorization code flow from chapter 3 run a second time, with the roles moved along one seat. AuthHero becomes the *application*, Google is the *identity provider*, and when Google sends the user back, AuthHero carries on with its own flow as if a password had been typed.

AuthHero has built-in connections for **Google**, **Apple**, **Facebook**, **GitHub**, **Microsoft** accounts and **Vipps**. Setting one up means registering with the provider, then pasting a client ID and secret into the connection.

Your application still talks only to AuthHero. It gets the same tokens with the same claims whether Maya used a password or her Google account.

## The company's login: enterprise

Larder's bigger customers do not want their staff to have a Larder password at all. They already have a company directory, and they want Larder to trust it. That is an **enterprise connection**: the same idea as a social login, pointed at one company's identity provider.

AuthHero connects to anything that speaks **OpenID Connect**, **SAML** or plain **OAuth 2.0**, with ready-made connection types for **Okta** and **Microsoft Entra ID**. Chapter 10 says more about SAML, the older of the three.

That raises a practical question. A login page cannot show a button for each of two hundred customers. **Home realm discovery** solves it. You list a company's email domains on its connection, such as `noodlebar.example`. When someone types `sam@noodlebar.example` into the ordinary login page, AuthHero recognises the domain and sends Sam straight to Noodle Bar's own login. Everyone else continues to the password or code step. There are no extra buttons and no "which company are you from?" screen.

## Passkeys

A **passkey** is a key pair created by the user's device. The private half never leaves the phone or laptop, where it is unlocked with a fingerprint, a face or a PIN. The website only ever holds the public half. To log in, the device signs a challenge. Nothing secret crosses the network, nothing reusable can be stolen from the server, and because the browser ties each passkey to the website it was created for, a fake login page gets nothing.

AuthHero supports passkeys as a way to sign in, and can offer users the chance to create one right after they log in some other way. That is how most people end up with one. The same technology also serves as a second factor, which is the subject of the next chapter.

## One person, several doors

Give people several ways in and they will use more than one. Maya signs up with a password in March. In June she clicks "Continue with Google" out of habit. Without care, Larder now has two Mayas, and one of them has no stock lists.

**Account linking** merges them. One account is the **primary**. The others hang off it as additional **identities**. Whichever door Maya uses, she arrives as the same user with the same user ID, and her tokens are the same.

AuthHero links automatically when an identity arrives with the same email address as an existing account in the same tenant, **and the arriving identity's email is verified**. The condition matters. If unverified addresses were enough, anyone could sign up with your address and be merged into your account.

The check is on the identity that is arriving. The account it joins is not checked again. So do not leave password accounts usable with an unverified address: have the application require a verified email before a password login completes, as described above. You can also switch the automatic behaviour off, or decide linking yourself in code.

A user ID records where the account came from: `auth0|6650f3a1c2` for a database user, `google-oauth2|1098…` for one who arrived through Google. The primary account's ID is the one that appears as `sub` in tokens.

## Choosing

There is no single right answer, but here is a reasonable starting point.

| If your users are… | Offer |
| --- | --- |
| Consumers | Email code or magic link, one or two social logins, passkeys |
| Staff at small businesses | Password and email code, plus Google and Microsoft |
| Staff at large companies | Their own enterprise connection, found by email domain |

You can change your mind later. Connections are configuration, and the applications never know the difference.

**In the docs:** [Connections](/entities/configuration/connections) · [Home Realm Discovery](/features/home-realm-discovery) · [Users](/entities/identity/users) · [Account Linking](/auth0-comparison/account-linking) · [User Creation Flow](/features/user-creation-flow)
