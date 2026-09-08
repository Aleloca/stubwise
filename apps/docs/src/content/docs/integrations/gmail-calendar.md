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

These rules decide **where** an email that has already entered Stubwise
goes, not **whether** it enters at all — that's a separate, instance-wide
gate, described in [Admitted mail](#admitted-mail) below. A project with no
rule that matches a given message gets no proposal from it directly, but see
[When no project matches](#when-no-project-matches): if *no* project's rules
match an admitted message, Stubwise still considers every project a
candidate and lets the classifier — and, failing that, a human — decide,
rather than dropping the message.

A message can be in scope for more than one project at once, and each project
that matches gets its **own, independent proposal** — see [One email, several
projects](#one-email-several-projects) below. This makes putting the same
domain, label or keyword on more than one project a genuinely sensible thing
to do: every project it matches gets a proposal, instead of the rules simply
competing for a single winner.

:::note[A keyword only in the body doesn't pull a message into scope]
Downloading a message body is the expensive part of the sync, so Stubwise
checks admission and routing **twice**: first on headers and labels alone
(cheap) to decide whether to download the body at all, then again — routing
only, now with the full text — once it has. A keyword rule that matches
solely inside the body — not the subject — never gets the chance to admit a
message on its own, because the body isn't fetched yet; it can still resolve
*which* project an already-admitted message belongs to, once the body is in.
To catch a message on a keyword alone, make sure it also appears in the
subject.
:::

## Admitted mail

Before any project routing rule is even consulted, Stubwise decides whether a
message is worth looking at *at all* — this is **admission**, configured
instance-wide by an admin under **Settings → Google → Admitted mail**, and it
answers a different question than routing does: not "which project is this
about" but "is this work, or not worth reading".

- **Admit mail from registered Workspace domains** (on by default). A sender
  — or a recipient CC'd — on a domain belonging to any registered Google
  Workspace is admitted automatically, with **no project rule needed at
  all**. This is the whole point: before this existed, admitting your own
  organization's mail meant writing the same domain as a routing rule on
  every single project that should see it — four domains repeated across a
  dozen projects. Turning this off falls back to the older behavior, where
  only a matching project rule (see above) admits a message; domains outside
  your Workspaces (a client's, a partner's) still admit exactly as before,
  through a project rule.
- **Always exclude these Gmail labels** (defaults to Promotions, Social and
  Spam). A message carrying one of these labels is discarded even if it
  would otherwise be admitted by a Workspace domain or a project rule —
  exclusions always win.
- **Discard automated mail** (on by default). Newsletters, mailing lists and
  automatic notifications — detected from standard headers
  (`List-Unsubscribe`, `List-Id`, bulk `Precedence`, `Auto-Submitted`) — are
  dropped before they ever reach a project, on the same principle.

The settings page also lists, read-only, every domain that would currently be
admitted — the union of all registered Workspaces' domains — so an admin can
check the effect of the toggle without guessing.

## What happens to your email

1. **Incremental sync.** A background process checks each active, connected
   mailbox on its own schedule and fetches only what changed since the last
   check (Gmail's History API) — not a fresh scan of the whole inbox every
   time.
2. **Pre-filter before any download.** Sender, recipients, labels and a few
   headers are checked against the [admission rules](#admitted-mail) above —
   a Workspace domain, an exclusion, or (if no Workspace domain applies) a
   matching project routing rule. A message that isn't admitted is discarded
   right there — its body is never downloaded, and no trace of it is stored
   in Stubwise.
3. **Classification, on text alone.** Only messages that passed the filter
   have their body fetched and handed to a language model — and *only* the
   model, nothing else. The run has **no filesystem access and no tools**: it
   reads the sender, subject and text you'd expect, plus a short list of open
   tickets and backlog titles for context — for each project a routing rule
   already matched, or, if none did, for every project on the instance (see
   [When no project matches](#when-no-project-matches)) — and proposes an
   action. It cannot browse anything, run anything, or take any action by
   itself — the most it produces is a suggestion, which Stubwise's own code
   then double-checks against real data (is that ticket actually open? is
   that project actually a candidate?) before it's ever shown to anyone.
4. **A proposal in your inbox — one per matching project.** If something
   useful comes out, a card appears — **only for the mailbox owner** — for
   *each* project the message is confidently attributed to, showing the
   project's name, the sender or event, a short recognized signal (decision,
   request, deadline, blocker), and a short list of options plus **Ignore**.
   One tap confirms; nothing happens until you do.
5. **Calendar, without AI.** Events on your primary calendar go through the
   same routing rules (attendee domains, keywords in the title) but skip the
   model entirely: an in-scope event deterministically proposes creating a
   milestone named after the event, due on the event's date. The same event
   is never proposed twice, and a cancelled event is simply marked as such —
   no mutation. Unlike email, a calendar event always resolves to **at most
   one** project — see below.

Every proposal, confirmed or not, appears on your personal **Mail** page
(`/mail`), with a link back to the original Gmail thread or calendar event,
and a **Repropose** action for anything that failed or was ignored by
mistake. A message that produced more than one proposal shows up as more
than one row — same sender, same subject, a project badge telling them
apart.

## One email, several projects

A single email often isn't about just one project — the recap of an internal
meeting that covers progress and next steps on two or three initiatives at
once is the common case in an instance with a dozen projects. Stubwise
classifies that message **once per matching project**, using only that
project's own context (its open tickets, its backlog titles), and produces a
**separate proposal for each one** — each with its own options, its own
**Ignore**, and its own confirmation. Confirming, ignoring, or reproposing one
of them never touches the others: they're independent from the moment they're
created.

There's a cap on how many projects a single message can fan out to
(`GMAIL_MAX_PROJECTS_PER_MESSAGE`, self-hosting only, default 5) so that one
message copied to a large number of projects doesn't flood everyone's inbox
at once; the projects with the strongest match survive the cap.

The calendar is deliberately **not** part of this: an event still resolves to
a single project (or none, if the routing rules tie), exactly as before this
capability was added — a meeting invite doesn't need to become several
milestones just because several projects are represented.

## When no project matches

An email can be [admitted](#admitted-mail) — a Workspace domain vouches for
it — without any project's routing rules matching it at all: this is exactly
the case admission by domain was built for, since it removes the need to
repeat the same rule on every project. When that happens, Stubwise doesn't
just drop the message: it classifies it against **every project on the
instance**, not just the ones a rule already pointed to.

- If the model finds no real signal, the message is simply ignored, same as
  always.
- If it finds a signal and can confidently name the project it's about, a
  normal proposal is created for that project — no different from one that
  arrived through a routing rule.
- If it finds a signal but **can't** confidently attribute it to a project,
  a different kind of card appears: *"it looks like work, but it's not clear
  which project — which one does this belong to?"*, with up to three
  suggested projects to pick from plus **None of these**. Picking a project
  attributes the message and sends it back through classification, now with
  that project resolved — the normal proposal(s) that follow are indistinguishable
  from any other. **None of these** archives the message with an outcome
  that says it was triaged and dismissed, so it doesn't read as "no signal
  found" on your Mail page.

This only ever happens for a message that matched **no** project's routing
rules — as soon as at least one rule matches, the candidate set narrows back
down to the matching projects, same as before this existed.

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
