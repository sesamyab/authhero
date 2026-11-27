---
title: A second lock
description: Multi-factor authentication in AuthHero. The factors, when to require them, how users enroll, and how to roll MFA out without a support flood. Chapter 7 of the AuthHero Book.
---

<p class="book-kicker">Chapter 7 · Signing in</p>

# A second lock

Passwords leak. They are reused across sites, typed into fake pages, and guessed. An account protected by nothing else is one bad day away from belonging to someone other than its owner.

**Multi-factor authentication** (MFA) asks for a second, different kind of proof. The usual way to sort the kinds:

- something you **know**: a password, a PIN
- something you **have**: a phone, a security key
- something you **are**: a fingerprint, a face

Two proofs of the same kind add little. A password plus a "security question" is two things you know, and both can be phished in the same email. A password plus a code from the phone in your pocket is a real second lock, because the attacker now needs your phone as well.

## The factors

AuthHero supports these as second factors:

| Factor | What the user does | Good to know |
| --- | --- | --- |
| **Authenticator app** (TOTP) | Types a six-digit code from an app such as Google Authenticator or 1Password | Works offline and needs no provider. The easiest place to start. |
| **SMS** | Types a code sent by text message | Familiar to everyone, but needs an SMS provider, and phone numbers can be hijacked. |
| **Security key** (WebAuthn) | Touches a hardware key such as a YubiKey | Cannot be phished. |
| **Device biometrics** (WebAuthn) | Uses Touch ID, Face ID or Windows Hello | Cannot be phished, and there is nothing extra to carry. |
| **Passkey** | Same gesture as above | The passkey from chapter 6 can serve as either the first factor or the second. |

You enable the factors you want per tenant. If several are on, the user chooses.

## Where it sits in the dance

MFA is one more step in the middle of the flow from chapter 3. Maya enters her password. When the login reaches `/authorize/resume`, AuthHero sees that a second factor is required and has not been given, marks the login session as *awaiting MFA*, and sends her to the challenge page. Once the code checks out, the flow continues and tokens are issued.

The application sees none of this. It asked for a login and got one.

The first time, there is nothing to challenge yet, so the user **enrolls**. For an authenticator app that means scanning a QR code and typing one code to prove the setup worked.

A session remembers that MFA was completed. When Maya moves to a second Larder application the same morning, single sign-on carries her through without another code. And if an application asks silently with `prompt=none` on a session that has not done MFA when the tenant requires it, the answer is `interaction_required`, not tokens.

## When to ask

There are two ways to decide who gets challenged.

**The tenant policy** is the blunt instrument: MFA is either never required or always required for every interactive login.

**An Action** is the precise one. Chapter 11 covers Actions properly, but here is one that requires MFA for managers only:

```js
exports.onExecutePostLogin = async (event, api) => {
  if (event.authorization?.roles.includes("manager")) {
    api.multifactor.enable("any");
  }
};
```

The condition can be anything you can compute at login: a role, an application, a customer company, an email domain. This is how most rollouts actually go. Leave the tenant policy on *never*, and require MFA exactly where the risk is.

One honest gap: Auth0 offers "adaptive" MFA, which challenges only when a login looks risky. AuthHero has no risk score. It accepts that policy value so Auth0 tooling keeps working, and then treats it as *always*, which fails in the safe direction.

## Remember this device

Asking for a code at every single login teaches people to resent security. AuthHero can show a **Remember this device** checkbox when it asks for an authenticator or SMS code. Tick it, and that browser skips the challenge for the same user for a set number of days, 30 unless you change it.

It is off by default and has to be allowed by whatever required the MFA: the tenant setting for the tenant policy, an option on the call for an Action. Two details show the care taken. A remembered browser satisfies the requirement but is not recorded as a fresh MFA, so an application that inspects the token to see whether MFA really happened can tell the difference. And if a device is lost, one API call makes every remembered browser for that user ask again.

## Rolling it out without a riot

Turning on *always* on a Monday morning means every user meets an unfamiliar enrollment screen at the exact moment they are trying to get to work. There is a gentler path:

1. Enable the factors, and leave the policy on *never*.
2. Send **enrollment tickets**. A ticket is a one-time link, valid for five days, that takes a user directly to MFA setup. They can do it when they have a minute.
3. Watch enrollment grow. Each user's registered methods are visible in the admin dashboard and through the API.
4. Require MFA for the riskiest group first, with an Action.
5. Flip the policy to *always* once most people are ready.

## When someone loses their phone

They will. A user who can still log in can add or remove their own factors on the self-service account page (chapter 8). A user who cannot get in needs an administrator to remove the lost method, after which the next login asks them to enroll afresh.

Decide beforehand how your support team verifies that the person asking is the account owner. That conversation is the weakest point of any MFA setup, and no software can have it for you.

**In the docs:** [Multi-Factor Authentication](/features/mfa) · [Actions](/features/actions) · [Account management page](/features/account-linking)
