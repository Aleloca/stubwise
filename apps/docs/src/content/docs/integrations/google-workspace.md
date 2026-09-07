---
title: Google Workspace
description: Create the internal OAuth app your organization needs so that members can connect their Gmail and Calendar mailboxes to Stubwise.
---

Stubwise can read a member's **Gmail** and **Google Calendar** to turn incoming
email and meetings into proposals you confirm with one tap. Nothing is read
until two things happen, in this order:

1. an **admin registers a Google Workspace** in Stubwise — the *internal* OAuth
   app of your organization (this page);
2. each member **connects their own mailbox** from **Settings → Account**, with
   the usual Google consent screen.

:::caution[One OAuth app per organization, created by you]
Stubwise does **not** ship a Google client of its own: a self-hosted instance
gets its own OAuth app, created in **your** Google Cloud project, so the
credentials and the data never leave your organization. The app is of type
**Internal**, which means only accounts of your Workspace can grant it consent —
and Google does **not** require the verification process that public apps go
through.
:::

## What you need

- A Google **Workspace** (not a personal Gmail account): the *Internal* app type
  only exists inside an organization.
- Access to the [Google Cloud Console](https://console.cloud.google.com/) with
  permission to create a project and OAuth credentials.
- The **admin** role in Stubwise.

## 1. Create (or pick) a Google Cloud project

In the Google Cloud Console, use the project picker in the top bar and choose
**New Project**. Name it something recognizable — `stubwise-integration` — and
create it. Everything below happens inside that project; keep it selected.

## 2. Enable the Gmail and Calendar APIs

Go to **APIs & Services → Library** and enable both:

- **Gmail API**
- **Google Calendar API**

Enabling only one of them makes half of the integration fail silently later, so
do both now even if you only care about email today.

## 3. Configure the OAuth consent screen as *Internal*

Go to **APIs & Services → OAuth consent screen**:

1. Choose the **Internal** user type. This is the important choice: an internal
   app is limited to accounts of your Workspace and needs no Google review.
2. Fill in the app name (for example `Stubwise`), the support email and the
   developer contact email. These are what your members see on the consent
   screen.
3. On the **Scopes** step you do not have to pre-declare anything: Stubwise
   requests its scopes at authorization time. For the record, they are the four
   read-only scopes shown in **Settings → Google** in Stubwise:

   ```
   openid
   email
   https://www.googleapis.com/auth/gmail.readonly
   https://www.googleapis.com/auth/calendar.readonly
   ```

   Both Google scopes are **read-only**: Stubwise can never send an email,
   modify a thread, or change an event.

## 4. Create the OAuth client

Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**:

1. Application type: **Web application**.
2. Name: anything, for example `Stubwise server`.
3. Under **Authorized redirect URIs** add exactly the URI that Stubwise shows in
   **Settings → Google**, in the box *Paste into the Google Cloud Console*:

   ```
   {publicUrl}/api/me/google/callback
   ```

   `{publicUrl}` is your instance's public URL. Copy the value from that box
   rather than typing it: Google compares the redirect URI **character by
   character**, and a missing `https://`, an extra trailing slash or the wrong
   host all produce the same `redirect_uri_mismatch` error at consent time.

4. Create, then copy the **Client ID** and the **Client secret**.

## 5. Register the Workspace in Stubwise

In Stubwise open **Settings → Google** (admin only) and select **New
Workspace**:

- **Name** — how you want to see it in the list, for example the company name.
- **Email domains** — the email domains of your Workspace, comma- or
  space-separated (`acme.com, mail.acme.com`). They are stored lowercase.
- **Client ID** and **Client secret** — the two values from step 4.

Save. The row appears with a **Secret set** badge.

:::note[The domains are a boundary, not a label]
When a member connects a mailbox, Stubwise checks the domain of the Google
account against this list and **refuses** anything outside it. This is what
keeps a personal `@gmail.com` account out of a company Workspace. If a member
reports that connecting fails with *domain mismatch*, the missing entry is
almost always here.
:::

## 6. Let members connect their mailbox

Registering the Workspace does not connect anything by itself: it only makes the
option available. Each member goes to **Settings → Account**, chooses **Connect
a mailbox**, picks the Workspace and grants consent on Google. A mailbox is
always personal — only its owner sees the proposals it generates, and only its
owner can disconnect it.

## Maintenance

- **Rotating the client secret** — create a new secret in the Google Cloud
  Console, then paste it in the Workspace form in Stubwise. The field is
  write-only: leaving it empty keeps the stored one, so type in it only when you
  actually want to replace the secret. Existing mailboxes keep working.
- **Removing the secret** — tick *Remove stored client secret*. The Workspace
  stays in the list but no new mailbox can be connected until a secret is set
  again.
- **Deleting a Workspace** — only possible when no mailbox is connected to it;
  otherwise Stubwise answers that the Workspace is still in use. Ask the owners
  to disconnect their mailboxes first (**Settings → Account**).
- **Adding a domain** — edit the Workspace and add it to the list. Mailboxes
  already connected are unaffected.

## Security notes

- The **client secret is encrypted at rest** with the instance encryption key
  and is never returned by the API — the interface can only tell you *whether*
  one is set.
- Stubwise stores **no access token**: for each mailbox it keeps only the
  encrypted refresh token and obtains a short-lived access token when it needs
  one. A database dump without the encryption key gives access to no mailbox.
- Every scope requested is **read-only**.
