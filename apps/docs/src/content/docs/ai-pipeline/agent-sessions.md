---
title: Agent sessions
description: Watch the agent work live, replay what it did, answer its questions and, if you are a maintainer, write to it while it runs.
---

Every time the agent works for you — planning a ticket, fixing it, correcting a
pull request, reviewing one, generating Docs — Stubwise records a **session**: a
live transcript of what the agent says and which tools it uses. You can watch it
as it happens and replay it afterwards.

A session is **a unit of work, not a process**. A fix has one session for the
whole job: planning, the pause for approval, the execution and the self-repair
are *steps* of the same transcript, separated by markers. A session that stops
on a question and resumes after the answer is still the same session.

## Where to find it

- **Agents** in the sidebar, visible to every user: what is working now, and
  what finished in the last 14 days. You can filter by project and by outcome.
  Each row says what the agent is doing right now, and for how long.
- On a **ticket**, next to the job: **Watch the session** while it runs,
  **Replay the session** once it is over. The link only appears if the instance
  has a session for that job.
- In the **inbox**, the notification of a question from the agent opens the
  session at the question.

If the instance does not have the feature (an older server), the Agents page says
*"Agent sessions are not available on this instance"* and tickets show no link.

## What each state means

| State | Meaning |
| --- | --- |
| **working** | The agent is running, or the job is between two steps. |
| **waiting for an answer** | The agent asked a question and is parked until someone answers. |
| **waiting for plan approval** | The plan is ready and a maintainer must approve it. |
| **on hold** | The job is parked (provider limit, budget, automation gate) or a Docs generation is paused. |
| **queued** | Waiting for its turn. Work on one project is serialised. |
| **ended** | Over. The outcome says how: *completed*, *failed* or *skipped*. |

State and outcome are derived by the server every time you look; they are never
guessed in the browser. The elapsed time is counted from the start date, so it
stays right on a page left open.

## Who can write, and on which steps

Anyone can **watch**. **Answering a question** from the agent is open to the
person who requested the work and to maintainers — it is a different action from
intervening, and it works exactly as it does from the ticket page.

**Writing to the agent** while it works is for maintainers (admins) only, and
only on steps where an extra instruction makes sense:

- planning, resuming a plan after an answer,
- execution and self-repair,
- a correction of a pull request,
- a backlog deep dive and the backlog chat.

**PR reviews and Docs generation are watch-only**: their result is a fixed
output (a verdict, a document) and a message would only break it. On those steps,
and for anyone who is not allowed, there is simply no message field.

Whether you can write is decided by the **server** for each session, not by your
role as the page sees it: if the field is not there, you cannot use it.

## Send, or Stop and send

The message field has two buttons:

- **Send** puts the message in the queue. The agent reads it when the current
  action finishes.
- **Stop and send** interrupts what the agent is doing right now and then
  delivers the message, so the agent changes direction. An interruption always
  carries a message.

Once delivered, your message is also posted as a **comment on the ticket** (for
sessions tied to a ticket; a backlog deep dive or chat has none). Ticket
comments from people are read by later fix runs, so the instruction is not lost
on a retry.

An intervention never replaces the deliverable of a step. The agent is reminded
to finish what the step was asked to produce. If you write while planning or resuming a plan and
the plan comes back without the structure the approval needs, **the job fails
with a clear message** ("The intervention replaced the plan: rerun it with the
instructions") instead of parking a broken plan.

## Why a message can be "not delivered"

Every message shows its status: *delivering…*, *delivered* or *not delivered*,
with the reason. It is never lost silently. A message is not delivered when:

- the session was no longer active when the message was picked up (it ended, or
  the worker restarted);
- the agent stopped accepting messages. On **plan, plan resume, deep dive and
  backlog chat**, the deliverable is the agent's answer itself: after its first
  successful answer it is already complete, so a message sent after that point
  is not delivered and no new turn starts. On execution, self-repair and
  corrections the deliverable is the files, so messages stay possible until the
  step ends.

A message that was absorbed in the middle of a turn is still fine; the limit is
only about writing *after* the answer is complete. If your message was not
delivered, use the ticket's **Relaunch with instructions**.

## Privacy and retention

- Sessions of **email classification** are visible only to the **owner of the
  mailbox**, never to admins, like the rest of that person's mail.
- Secrets are **masked** in the transcript on a best-effort basis: the values
  of the project's environment files and the provider credential are replaced
  by `•••` wherever they appear verbatim. A derived, encoded or split value is
  not caught, and very short values are left alone. Treat it as a safety net,
  not a guarantee: do not paste secrets to the agent.
- Sessions are kept for **14 days** from their last activity, then deleted with
  their events and messages. A session of an email also goes when the email does.
