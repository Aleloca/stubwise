---
title: Gmail and Calendar
description: Turn email and calendar events into proposals you confirm with one tap — routing per project, read-only access, AI classification on text alone.
---

Stubwise can turn a member's incoming **Gmail** and **Google Calendar** into
**proposals** in the inbox: create a backlog item, open a milestone, update or
comment on a ticket, record a decision — each one a single tap away, and never
without it. Access is **read-only**: Stubwise cannot send an email, change an
event, or write anything back to Google.

This page covers the whole path, end to end. If you only need the Google Cloud
side of the setup, see [Google Workspace](/docs/integrations/google-workspace)
— that page is linked again below.

## For the admin

Two things have to happen, in order, before anyone can connect a mailbox:

1. **Create the internal OAuth app** in your organization's Google Workspace.
   This is a one-time, per-organization setup in the Google Cloud Console —
   fully covered in [Google Workspace](/docs/integrations/google-workspace):
   an *Internal* app (no Google verification needed), the Gmail and Calendar
   APIs enabled, and an OAuth client with Stubwise's redirect URI.
2. **Register it in Stubwise**, under **Settings → Google**: name, email
   domains, Client ID and Client secret. The secret is encrypted at rest and
   never shown again — the form only tells you whether one is set.

Until a Workspace is registered, **Settings → Account** shows members a
message pointing them to a maintainer instead of a "Connect a mailbox"
button — there's nothing to connect to yet.

A Workspace can be edited (rotate the secret, add a domain) or deleted; a
delete is refused while any mailbox is still connected to it, so a member has
to disconnect first.

## For the user

Once a Workspace exists, go to **Settings → Account → Google mailboxes** and
choose **Connect a mailbox**. Pick the Workspace (if more than one is
configured) and grant consent on Google's own screen — you'll see the same
four read-only scopes the admin saw when creating the app. Google account
outside the Workspace's domains? The connection is refused with a clear
reason (`domain_mismatch`) rather than silently accepted.

You can connect more than one mailbox — useful if you work across several
Workspaces or want a shared team inbox tracked too. Each mailbox is entirely
personal: **only its owner ever sees the proposals it produces**, not an
admin, not a teammate.

Each connected mailbox shows:

- **Active** or **Disabled**, with a reason when disabled — `authorization no
  longer valid: reconnect` (`invalid_grant`), `access revoked on Google`
  (`revoked`), `missing permissions: reconnect` (`insufficient_scope`), `the
  Workspace was removed` (`workspace_removed`), or `too many sync failures in
  a row` (`sync_failed`). **Reconnect** repeats the consent flow and clears
  the disabled state.
- **Proposals on for this mailbox** — a toggle. Turning it off stops new
  proposals from that mailbox without disconnecting it; existing proposals
  stay exactly as they are.
- **Disconnect** — revokes Stubwise's access on Google (best effort) and
  removes the mailbox. Messages and proposals already produced are not
  deleted; they simply won't get new siblings.

## For a project maintainer

A mailbox being connected doesn't mean its mail reaches any project — that's
a separate, explicit step. In a project's **Mail** section, a maintainer
defines **routing rules**: which incoming messages are about *this* project.
Three kinds of rule, any of which can match:

- **Senders and recipients** — a domain (`acme.com`) or a single address
  (`mario@acme.com`), checked against `From`, `To` and `Cc`.
- **Gmail labels** — a label the mailbox owner has put on the project's mail;
  a picker suggests labels already observed on messages Stubwise has seen.
- **Keywords** — matched in the subject and the body.

**No rule at all means no mail for that project** — routing is opt-in by
design, and this is the actual perimeter of what Stubwise reads from anyone's
mailbox, not just a label used afterwards.

When two or more projects could claim the same message, the one satisfying
**the most rules** wins. A tie resolves to no project and the message becomes
an *ambiguous* proposal, listing the tied candidates — Stubwise would rather
ask than guess.

:::note[A keyword only in the body doesn't pull a message into scope]
Downloading a message body is the expensive part of the sync, so Stubwise
checks routing **twice**: first on headers and labels alone (cheap), and only
downloads the body if that already puts the message in scope. A keyword rule
that matches solely inside the body — not the subject — never gets the chance
to be evaluated, because the body isn't fetched yet. To catch a message on a
keyword alone, make sure it also appears in the subject.
:::

## What happens to your email

1. **Incremental sync.** A background process checks each active, connected
   mailbox on its own schedule and fetches only what changed since the last
   check (Gmail's History API) — not a fresh scan of the whole inbox every
   time.
2. **Pre-filter before any download.** Sender, recipients and labels are
   checked against every project's routing rules using only message
   *metadata*. A message that matches nothing is discarded right there — its
   body is never downloaded, and no trace of it is stored in Stubwise.
3. **Classification, on text alone.** Only messages that passed the filter
   have their body fetched and handed to a language model — and *only* the
   model, nothing else. The run has **no filesystem access and no tools**: it
   reads the sender, subject and text you'd expect, plus a short list of the
   project's open tickets and backlog titles for context, and proposes an
   action. It cannot browse anything, run anything, or take any action by
   itself — the most it produces is a suggestion, which Stubwise's own code
   then double-checks against real data (is that ticket actually open? is
   that project actually a candidate?) before it's ever shown to anyone.
4. **A proposal in your inbox.** If something useful comes out, a card
   appears — **only for the mailbox owner** — showing the sender or event,
   a short recognized signal (decision, request, deadline, blocker), and a
   short list of options plus **Ignore**. One tap confirms; nothing happens
   until you do.
5. **Calendar, without AI.** Events on your primary calendar go through the
   same routing rules (attendee domains, keywords in the title) but skip the
   model entirely: an in-scope event deterministically proposes creating a
   milestone named after the event, due on the event's date. The same event
   is never proposed twice, and a cancelled event is simply marked as such —
   no mutation.

Every proposal, confirmed or not, appears on your personal **Mail** page
(`/mail`), with a link back to the original Gmail thread or calendar event,
and a **Repropose** action for anything that failed or was ignored by
mistake.

## Privacy

- **Only the mailbox owner sees a mailbox's proposals.** Not an admin, not a
  project maintainer, not anyone else — this is enforced the same way for
  every proposal a mailbox produces, with no exception.
- **Read-only, always.** The scopes Stubwise requests can only read Gmail and
  Calendar. There is no code path that sends an email, replies, or modifies
  an event.
- **Email text never reaches the logs.** Errors and diagnostics reference
  message IDs and technical failures, never the content of a message.
- **Retention is configurable.** An instance admin sets how many days a
  fully-handled message (actioned, ignored or failed) is kept before it's
  deleted (`GMAIL_RETENTION_DAYS`, self-hosting only) — open proposals are
  never pruned by this.
- **No access token is ever stored.** Stubwise keeps only an encrypted refresh
  token per mailbox and exchanges it for a short-lived access token each time
  it needs one.

See also [Google Workspace](/docs/integrations/google-workspace) for the
admin-side OAuth app setup, and [Roadmap, brief and decisions](/docs/team/roadmap-briefs-decisions)
for how a confirmed proposal shows up in a project's decision register.
