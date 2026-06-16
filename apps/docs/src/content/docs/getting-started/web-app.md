---
title: The web app
description: Admin setup, invites, projects, Kanban board and ticket detail with the AI job timeline.
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

Tickets created by hand have source `manual`. Those arriving from the SDK have
source `sdk_error` or `sdk_feedback`; those created via API have `api`.

## The ticket detail

The detail page gathers everything about a ticket:

- the **technical payload** of the error (message, stack trace, URL, release,
  breadcrumbs), when the ticket comes from an error captured by the SDK;
- the **comments**, both human and AI (an `ai` comment annotates the pipeline's
  decisions: skip, duplicate, or the link to the opened PR);
- the **AI job timeline**: each job shows status and logs, so you follow triage
  and fix step by step.

When the AI pipeline opens a pull request, the ticket moves to `in_review` and
an `ai` comment with the link to the PR and the report appears in the detail.
When the PR is merged — if the git webhook is configured — the ticket
automatically moves to `done`.
