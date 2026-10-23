---
title: Two-factor sign-in
description: "Every sign-in asks for a second factor: set up an authenticator app, save your backup codes, add a passkey, and what to do if you lose your phone."
---

Stubwise asks for a **second factor** every time you sign in, for everyone and
with no exceptions by role. Your password alone never opens the app: it only
takes you to the second step. This protects your account, and the things it
can reach, if the password is ever stolen.

## Setting it up

The first time you sign in (for everyone, right after the feature is
released), Stubwise walks you through a mandatory setup:

1. Scan the **QR code** with an authenticator app (any app that supports
   six-digit time-based codes works). If you can't scan it, type the secret
   shown under the code.
2. Enter the six-digit code the app shows to confirm.
3. Save your **10 backup codes**. They are shown **once**: download them or
   write them down, then tick "I have saved the codes" to continue.

Only then does your session open. There is no way to switch two-factor off.

## Signing in

Enter your email and password, then the code from your app. A code can only be
used once: if you need another one right after signing in, wait for the app to
show the next. If you have registered a passkey, you can use it instead, and
"use a backup code" is always available.

After **5 wrong codes in a row** the second step is locked for **15 minutes**,
and you get a security alert. The lock only affects new sign-ins: sessions and
tokens that are already open keep working.

## Backup codes

Each backup code works **once** and counts as a second factor, both at sign-in
and when you confirm a sensitive action. Stubwise warns you when **3 or fewer**
are left. In **Settings → Security** you can generate a new set, which
invalidates the previous ones; the new codes are shown once.

## Passkeys

In **Settings → Security** you can add a **passkey** (Face ID, Touch ID or a
security key) and give it a name. You can rename or remove it later. Passkeys
are an addition, not a replacement: the authenticator app stays configured.
Passkeys work on the web only. The same page lets you reconfigure the
authenticator app; the old app keeps working until you confirm a code from the
new one.

## Confirming sensitive actions

Some actions ask for a second factor again if you haven't used one in the last
**10 minutes**: creating a personal access token, changing your password,
managing your own two-factor settings, changing roles and members, linking
Slack or Git identities, and resetting another person's password or two-factor.
A dialog asks for a code (or a passkey) and then repeats the action.

Personal access tokens can never confirm these actions, so a stolen token
can't create more tokens or change roles. The mobile app signs in with a code
(authenticator or backup); if you haven't set up two-factor yet, the app asks
you to do it on the web first.

## I lost my phone

- Sign in with a **backup code**, then set up the new device in
  **Settings → Security**.
- No backup codes? Ask someone who manages users to **reset your two-factor**
  from the **Team** page (see [Roles and members](/docs/team/roles-and-members/)).
  They need to confirm with their own second factor, and you receive a security
  alert outside the web app (push and Slack, plus the inbox). Your sessions are
  closed; at your next sign-in you set it up again.
- If you are the only administrator, whoever runs the server can reset your
  two-factor from the command line (see the deploy notes).

## Security alerts

You are notified in the inbox, by push and by Slack DM (if linked) when your
two-factor is reset by someone else, someone generates a password-reset link
for you, a passkey is added, backup codes are regenerated, or the second step
gets locked. These alerts can't be turned off in notification preferences.
Settings → Security also lists your recent security events.
