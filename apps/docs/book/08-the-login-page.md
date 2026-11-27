---
title: The login page
description: Universal Login in AuthHero. Why the login page is hosted, how the server-driven widget works, and how to brand it, translate it, extend it and embed it. Chapter 8 of the AuthHero Book.
---

<p class="book-kicker">Chapter 8 · Signing in</p>

# The login page

Everything in the last two chapters happens on a page that your application does not own. That page is called **Universal Login**, and handing it over is the best trade in this book.

## Why give up your login page

A login page you host inside your app has to collect a password, which means your app handles passwords. Every script on that page, including every analytics snippet and chat widget, can read what the user types. And each application needs its own copy.

A hosted page turns that around:

- **Passwords never touch your app.** It only ever sees a code and then tokens.
- **Single sign-on works**, because the session cookie from chapter 5 lives on the login domain.
- **New features appear without a release.** Turn on passkeys or MFA in the settings, and every application has them the same afternoon.

What you give up is pixel-level control inside the application, and this chapter is mostly about how much of that you can get back.

## How the page is built

AuthHero's current login pages live under `/u2/`. They are driven by an idea worth understanding, **server-driven UI**.

The page contains one web component, the AuthHero widget. The widget holds no login logic of its own. It asks the server "what should I show?", and the server answers with a description of a screen: a title, some fields, some buttons, perhaps an error message. The widget draws it. When the user submits, the server decides what comes next and describes that screen.

All the decisions stay on the server. Whether to ask for a password or send a code, whether MFA is due, whether this user must accept new terms first: none of that logic is in the browser. So a flow can change without shipping new front-end code, and it cannot be tampered with from the browser's developer tools.

There is also an older set of pages under `/u/`, rendered entirely on the server. They still work, and deployments that started on them can stay until they are ready. New tenants get `/u2`, and new features land there only.

## The screens

It is a longer list than most people expect. One login system has to cover every situation a user can be in:

| Group | Screens |
| --- | --- |
| Signing in | Identifier, password, email code, SMS code, magic link sent, passkey |
| Joining | Sign-up, verify email, accept invitation |
| Recovering | Request a reset, enter the reset code, choose a new password |
| Second factor | Choose a method, enroll or challenge for authenticator app, phone and passkey |
| Permission | Consent to what an application is asking for |
| Devices | Enter and confirm the code shown on a TV or kitchen display |
| Account | Profile, security, linked accounts, passkeys, delete account |

A tenant can show the email and password fields on one screen, or ask for the email first and decide what to show next. Asking first is what makes home realm discovery from chapter 6 possible. The page can also put a small "Last used" badge on the button a returning visitor chose last time, which quietly solves "did I sign up with Google or with a password?"

## Making it look like yours

Customization comes in layers, from a two-minute job to full control.

**Branding.** Upload a logo, pick a primary color, a background and a font. This is all most tenants ever need.

**Themes.** Finer control over the components: button shapes, input borders, spacing.

**CSS.** The widget exposes CSS custom properties and named parts, so a stylesheet can reach individual elements.

**Page templates.** The area *around* the login card is a template of your own, written in Liquid. You place ready-made pieces such as the logo, a dark-mode toggle, a language picker and legal links, and add your own markup between them. AuthHero keeps hold of the outer page shell, so the page stays accessible and responsive whatever you put in the template.

**Text.** The wording on a screen can be overridden per tenant.

## Speaking the user's language

The login screens ship in eight languages: English, Swedish, Norwegian, Danish, Finnish, Czech, Polish and Italian. An application asks for one with the standard `ui_locales` parameter on `/authorize`, for example `ui_locales=sv`. A tenant decides which of the languages it allows. Emails are translated the same way.

## Staying on your own page

Some products want login in a modal, without the user leaving the page. AuthHero's **embedded login** loads the same `/u2` screens in an `<iframe>`. The frame reports its height so the modal can resize, and posts the result back to your page when the user is done.

This keeps the main benefit of hosting. The form runs on the auth domain *inside* the frame, so scripts on your page still cannot read the password. The pages may only be framed by origins you have listed on the application, and every other site is refused.

## Asking for one more thing

Sometimes a login needs a detour. A new cook has to accept the hygiene policy before first use. A user who signed up with only an email should add a name.

**Forms** handle this. A form is a small flow you draw in the admin dashboard: steps with fields, text and checkboxes, branches that depend on what the user has already answered, and actions that run when a step is submitted. You attach it to a point in the login, and AuthHero shows it there, in the same widget and the same styling. To the user it is one more screen. To the application it is still a single redirect out and a single code back.

## The emails

A login system sends a surprising amount of email: verification codes, magic links, password resets, invitations. In AuthHero each one is a template you can edit, with a sensible default so that nothing is blank on day one. Templates use Liquid, pick up your branding, and follow the recipient's language.

Delivery goes through an email provider you configure. Mailgun, Resend and Postmark are supported out of the box. If you use something else, a custom provider Action (chapter 11) hands each message to your own code.

## The account page

Finally, there is a page users visit after they have logged in. Send them to `/account?client_id=…` and they reach a self-service area where they can edit their profile, change their email, add or remove MFA methods and passkeys, see and unlink connected accounts such as Google, and delete their account.

It is the unglamorous half of identity. It is also what stops your support team from spending its days changing email addresses by hand.

**In the docs:** [Universal Login](/architecture/universal-login) · [UI Widget](/customization/ui-widget/) · [Page Templates](/customization/ui-widget/liquid-templates) · [Embedded Login](/customization/embedded-login) · [Forms](/features/forms) · [Email Templates](/features/email-templates) · [Account page](/features/account-linking)
