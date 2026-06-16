---
title: The web app
description: Admin setup, invites, projects, Kanban board and ticket detail with the unified activity timeline.
---

The web app is a React SPA served by Caddy. This guide walks through it from
the first login to the tickets.

## First login: the admin

On first open, while no user exists yet, Stubwise shows the **setup** page: the
first user who registers becomes the **admin**. Once the admin is created, the
setup page disappears and you authenticate from the **login**.

## Inviting other members

Only admins can invite. From **Settings → Invites**:

1. enter the email of the person to invite and create the invite;
2. Stubwise generates a **registration link** with a token, in the form
   `https://DOMAIN/register?token=...`;
3. **copy the link and deliver it yourself** (email, chat, out of band): the
   token appears **only once**, here.

Whoever opens the link lands on the registration page already associated with
the invite and completes the sign-up. Invited users have the **member** role
(not admin): they see the project configuration read-only and cannot create new
ones.

## Storage (S3-compatible)

Attachments and SDK feedback screenshots are stored in an external,
**S3-compatible** object storage. An admin configures it from **Settings →
Storage**:

- **endpoint** — the S3 API endpoint of your provider;
- **region**;
- **bucket** — the bucket files are written to;
- **access key** and **secret key** — the secret key is **encrypted at rest**
  and never shown again in clear text.

Until storage is configured, **attachments are disabled** across the app: you
can't upload files to tickets and SDK feedback screenshots are silently dropped.
Any bucket exposing an S3-compatible API works — for example
[Hetzner Object Storage](https://www.hetzner.com/storage/object-storage/) or
[MinIO](https://min.io/).

## Creating a project

A project ties Stubwise to **one git repository**. From the **Projects → New**
menu (admin only) you set:

- **name** and **slug** (the slug goes into the SDK's DSN);
- git **provider**: `github` or `bitbucket`;
- **repository URL** and **default branch**;
- the **git credentials** (username/token) the worker will use to clone and open
  PRs. They are **encrypted at rest** with `ENCRYPTION_KEY` and are never shown
  again in clear text.

On the project page, the **Integration** section (visible to members too,
because integrating the SDK requires no privileges) shows the **ingestion key**,
the **DSN** and an **`init()` snippet** ready to copy. For admins there's also a
**Webhook** section with the URL and the HMAC secret to configure on the git
provider: when the PR is merged the ticket moves to `done`.

## Milestones

Each project can group its tickets into **milestones** — a name, an optional
**due date** and a status of **open** or **closed**. You manage them from the
**project page**, in the **Milestones** section: **any authenticated user** can
create, rename, close/reopen and delete them, because planning towards a
milestone is everyday work, not an admin-only privilege.

Every milestone shows its **progress**: the number of **completed** tickets over
the total assigned to it, with a proportional bar. "Completed" here means tickets
in the **`done`** state — work that is finished (PR merged / fix landed).
Tickets that are `closed` (an administrative close, e.g. won't-fix) do **not**
count as completed.

You assign a ticket to a milestone from the **ticket detail** (see
[Milestone assignment](#milestone-assignment)). Deleting a milestone does not
delete its tickets: they simply become unassigned.

## The Kanban board

The board shows a column for each state of a ticket's lifecycle, in order:

`open` → `triaged` → `in_progress` → `in_review` → `done` → `closed`

You drag a card from one column to another (drag-and-drop) to change its state;
a click on the card opens the detail. A per-project filter lives in the URL
parameters, so the view is shareable.

## Creating a ticket by hand

The **New ticket** button opens a dialog with:

- **title** (required);
- target **project**;
- **type**: `bug`, `feature`, `task` or `feedback`;
- **priority**: `low`, `medium`, `high` or `urgent`;
- **description** (body, optional).

The **description** is written with a **markdown editor** (see below).

Tickets created by hand have source `manual`. Those arriving from the SDK have
source `sdk_error` or `sdk_feedback`; those created via API have `api`.

## The markdown editor

The ticket **description** and the **comments** in the activity timeline are
edited with the same markdown editor. It has a **toolbar** that wraps the
current selection in markdown syntax — **Bold**, **Italic**, **Inline code**,
**Link** and **Bulleted list** — and two tabs, **Write** and **Preview**.
Switch to **Preview** to see the rendered markdown before you save; switch back
to **Write** to keep editing. The same renderer is used in the timeline, so the
preview matches the saved result.

## Searching tickets

The ticket list has a search field — **Search title, description, comments…** —
that runs a **full-text** search backed by Postgres. It looks across the
ticket's **title**, its **description (body)** and the **comments**, not just the
title.

Search uses **English stemming**, so it matches related word forms: a query for
`crashing` also finds tickets that say `crashes` or `crashed`. It is
**match-based**: a ticket either matches the query or it doesn't, and the results
stay in **chronological order** (newest first). Ranking results by relevance is a
planned future improvement.

The search tolerates queries with **special characters** (`&`, `:`, `!`, quotes,
and the like): they are handled safely and never cause an error.

## Filtering the list

The ticket list has a filter bar alongside the search field: **project**,
**status**, **type**, **priority** and **milestone**. The active filters live in
the URL parameters, so the view stays shareable.

The **milestone** filter is **per-project**: milestones belong to a project, so
the filter is enabled only when a **project** is selected, and it lists that
project's milestones. Switching project resets the milestone filter.

## Saved views

From the ticket list you can save the **current combination of filters** as a
**saved view**: give it a name and **Save**, then **apply** it later in one
click to restore exactly those filters. Saved views appear as a row of chips
above the filters.

A view is **private to its owner** by default. Tick **Share** when saving to
make it a **team view**: shared views are visible and applicable to everyone,
but only the **owner** can edit or delete them. Your own views are listed first;
your shared ones carry a **Shared** badge, and views shared by others show who
owns them. You remove your own views with a two-click confirm; you can't delete
someone else's shared view, only apply it.

## The ticket detail

The detail page gathers everything about a ticket:

- the **technical payload** of the error (message, stack trace, URL, release,
  breadcrumbs), when the ticket comes from an error captured by the SDK;
- the **AI activity** panel, with the job timeline and the actions you can take
  on the pipeline;
- the **Linked tickets** section, to relate this ticket to others;
- the **Attachments** section, with the files attached to the ticket;
- the **Activity** timeline, a single chronological stream of comments, AI job
  markers and the audit of human actions.

### Milestone assignment

The detail panel has a **Milestone** select listing the milestones of the
ticket's project (plus **None** to clear it). Pick one to assign the ticket, or
**None** to remove it; the current milestone is also shown as a chip near the
top of the page. Every change is recorded in the **Activity** timeline as a
`milestone_changed` entry (set, changed or removed).

### AI activity

The **AI activity** panel holds the technical detail of the pipeline: each job
shows its status and logs (cost and token usage appear in a separate **AI
usage** panel when there is any), so you follow triage and fix step by step.
This is also where you act on the pipeline:

- **Start AI fix** / **Relaunch with instructions** — kick off or re-run the fix
  from a terminal job state;
- **Approve** / **Reject** — when a job is waiting for plan approval.

### Linked tickets

The **Linked tickets** section relates a ticket to others in the same project.
Each link has a relation, shown from the current ticket's point of view:

- **Blocks** / **Blocked by** — this ticket must be resolved before the other;
- **Relates to** — a loose, symmetric connection;
- **Parent of** / **Child of** — a hierarchy between tickets.

You create only the **Blocks**, **Relates to** and **Parent of** directions; the
inverse — **Blocked by** and **Child of** — appears automatically on the linked
ticket. To add a link, use **Link ticket**: search the target **by title**
(within the same project), pick it, choose the relation and confirm. To remove a
link, click **Remove** on its row and confirm.

Adding or removing a link is recorded in the **Activity** timeline below, as an
audit entry.

### Attachments

The **Attachments** section lets you attach files to a ticket. It requires
[storage to be configured](#storage-s3-compatible); without it, the section is
unavailable.

You can upload **images** (`png`, `jpeg`, `gif`, `webp`), **PDFs**, **text and
log files** and **zip archives**, up to **10 MB** each. Images show a
**thumbnail preview**; other file types show a **download link**. Downloads go
through **short-lived signed URLs**, so files are never publicly exposable.

An attachment can be removed by **its author** or by an **admin**.

SDK feedback screenshots (see [Feedback](/docs/sdk/feedback/#attaching-a-screenshot))
arrive here automatically as attachments of the feedback ticket.

### Activity timeline

The **Activity** section is a single chronological stream that merges three
kinds of entry:

- **comments**, both human and AI (an `ai` comment annotates the pipeline's
  decisions: skip, duplicate, or the link to the opened PR);
- **AI job markers** — a compact status line for each job, with the **View PR**
  link when one is open. The full job detail (logs, cost) stays in the AI
  activity panel above;
- **audit entries** for human actions, recording who did what and when:
  status, assignee, priority, type, milestone or labels changed, and title or
  description edited.

The audit is automatic: every human change made to the ticket through the UI is
recorded and shown in the timeline. You add comments from the composer at the
bottom of the same section, using the same **markdown editor** as the ticket
description.

When the AI pipeline opens a pull request, the ticket moves to `in_review` and
an `ai` comment with the link to the PR and the report appears in the timeline.
When the PR is merged — if the git webhook is configured — the ticket
automatically moves to `done`.
