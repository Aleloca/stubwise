---
title: Milestones
description: Group a project's tickets into milestones with a due date and progress, and assign tickets to them from the ticket detail.
---

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

## Filtering by milestone

The ticket list has a **milestone** filter alongside the search field. It is
**per-project**: milestones belong to a project, so the filter is enabled only
when a **project** is selected, and it lists that project's milestones.
Switching project resets the milestone filter. See also
[The web app — Filtering the list](/docs/getting-started/web-app/#filtering-the-list).

## Milestone assignment

The ticket detail panel has a **Milestone** select listing the milestones of the
ticket's project (plus **None** to clear it). Pick one to assign the ticket, or
**None** to remove it; the current milestone is also shown as a chip near the
top of the page. Every change is recorded in the **Activity** timeline as a
`milestone_changed` entry (set, changed or removed).
