---
title: Roles and members
description: "Who can see which project and do what in it: permissions, the ready-made roles, custom roles, project members and invites."
---

Stubwise decides what each person can do from **permissions**, grouped into
**roles**. There are two levels:

- **Instance roles** apply to the whole installation. Every user has exactly
  one, set from the **Team** page.
- **Project roles** apply inside a project. A person sees a project only if
  they are a **member** of it, and their project role decides what they can
  do there.

The server is the only authority: every page and every API call checks the
permission it needs, and the web and mobile apps only show the buttons the
server says you can use. A project you're not a member of doesn't show up
anywhere — not in lists, search, the inbox or the pulse — and opening its
link answers "not found", exactly as if it didn't exist.

## Permissions

Permissions have stable English keys. You don't need to remember them: the
role editor shows each one with a label, grouped by area.

**Instance permissions** — about the installation as a whole:

| Permission | What it allows |
| --- | --- |
| `instance.full_admin` | Everything, on every project. See below. |
| `projects.create` | Create projects (the creator becomes the project's Project Lead). |
| `users.invite` | Invite people. |
| `users.manage` | Change someone's instance role, reset passwords, link Git/Bitbucket identities. |
| `users.view_all` | See the whole team list (otherwise: only people you share a project with). |
| `roles.manage` | Create, edit and delete roles. |
| `settings.manage` | Instance settings: automation, models, budget, notifications. |
| `ai_providers.manage`, `git_accounts.manage`, `plugins.manage` | Manage AI providers, Git accounts, the plugin registry. |
| `git_accounts.view` | See the list of Git accounts (without their credentials). |
| `mail_admission.view` | See the instance rules that decide which mail Stubwise looks at. |
| `integrations.manage` | Slack and Google Workspace. |
| `monitor.view`, `monitor.manage` | See or manage monitored servers. |
| `usage.view` | AI usage and costs of the whole instance. |

**Project permissions** — valid only in the projects where the person is a
member:

| Permission | What it allows |
| --- | --- |
| `tickets.view_all` | See every ticket (otherwise: only the tickets you opened or requested). |
| `tickets.create`, `tickets.edit`, `tickets.comment` | Open, edit, comment on tickets. |
| `tickets.moderate` | Delete other people's comments and attachments. |
| `runs.start` | Start an AI run on a ticket. |
| `plans.approve` | Approve or reject the AI's plan. **Without it, every run you start waits for someone who has it.** |
| `release.merge` | Merge pull requests from the [release queue](/docs/team/release-queue/). |
| `corrections.request` | Ask for changes on a pull request opened by Stubwise. |
| `prs.adopt` | Adopt a pull request opened by someone else. |
| `backlog.view_all`, `backlog.create`, `backlog.edit` | See every backlog item (otherwise: only your own requests), open requests, edit and refine items. |
| `docs.view`, `docs.edit`, `docs.generate` | Read, edit and (re)generate the project's Docs. |
| `repos.view` | See code, the code graph, pull requests and agent sessions. |
| `repos.manage` | Add and configure repositories, environment files, webhooks. |
| `agent_sessions.intervene` | Write into a live AI run. |
| `decisions.record` | Record decisions in the project's decision log. |
| `environments.manage`, `widget.manage` | Manage environments and the customer service widget. |
| `project.settings.manage`, `project.members.manage` | Project settings; adding and removing members. |
| `project.usage.view` | AI usage and costs of the project. |

### Full administration

`instance.full_admin` is special: it includes every permission, instance and
project, on **every** project. Full administrators are implicit members of
every project — they don't appear in a project's member list, but they see
it, can be assigned its tickets and receive its notifications.

There must always be at least one full administrator: Stubwise refuses any
change (a role change, editing or deleting a role) that would leave none.

## The ready-made roles

Seven roles come ready. Their names are in English and aren't translated.
You can rename and edit them like any other role.

| Role | Level | What it contains |
| --- | --- | --- |
| **Admin** | instance | `instance.full_admin` |
| **User** | instance | No administration: only the instance-wide reads everyone had before (team list, monitored servers, Git accounts, mail admission rules). |
| **Project Lead** | project | Every project permission. |
| **Developer** | project | Everything except approving plans, merging, project settings and members. |
| **Contributor** | project | Read the Docs, open tickets and backlog requests, comment. Sees only their own tickets and requests. |
| **Viewer** | project | Every "view" permission, no writing. |
| **Legacy Member** | project | Exactly what a "member" could do before roles existed. |

**Admin** and **User** can't be deleted for now: Stubwise still needs them
for people invited without an explicit role. The other roles can be deleted
once nobody uses them.

### Coming from the old maintainer/operator roles

When roles were introduced, every existing maintainer became **Admin**, and
every operator became **User** plus a member of **every** existing project
as **Legacy Member** — so nobody gained or lost anything on the day of the
switch. From there, remove people from the projects they don't need, give
each one a role that fits better (Developer, Contributor, Viewer), and
delete Legacy Member when nobody uses it any more.

A project created after the switch has no members except its creator: add
the people who need it from its **Members** section.

## Creating a role

**Settings → Roles** (needs `roles.manage`) lists instance roles and project
roles separately, with how many people use each one.

1. Choose **+ New instance role** or **+ New project role** — or
   **Duplicate** an existing role to start from it.
2. Give it a name (unique within its level) and tick its permissions.
3. **Save role**.

Editing a role changes it at once for everyone who has it. Deleting a role
works only when nobody has it any more: move those people to another role
first.

## Adding members to a project

Open the project: the **Members** section (needs `project.members.manage`
in that project) lists the members with their role.

- **Add a member**: pick a user and a project role.
- **Change a role**: pick another one next to the person.
- **Remove**: the person stops seeing the project right away. Their open
  notifications for that project disappear for them (and stay for everyone
  else), tickets stay assigned to them but are marked "assignee without
  access", and any decision waiting for them can still be taken by anyone
  else with the permission.

## Inviting people with their roles

From **Team → Invite a user** (needs `users.invite`) you can set, in the
same invite:

- the **instance role** — leave it on *Default (User)* for most people;
- **+ Add to a project**, once per project, with the **role** in each one.

When the person accepts the invite they get that instance role and become a
member of those projects. Without any project they can sign in but see no
project until someone adds them.

## You can't give more than you have

To keep permissions from growing by accident, a few rules apply to everyone
who isn't a full administrator:

- You can assign a role — or edit a role so that it becomes effective —
  only if all its permissions are ones **you** have (in that project, for a
  project role). Otherwise Stubwise answers with an "escalation" error.
- You can change the role of, remove, or reset the password of someone
  only if their current role has no permission you lack. Otherwise the
  error says the person is "above" you.

A full administrator is never limited by these rules.

## Slack, Claude Code and tokens

A personal access token (Claude Code, the MCP server) acts with the
permissions of the user who created it. In Slack, Stubwise acts with the
permissions of the Stubwise user linked to your Slack account (or whose
email matches your Slack profile): if there's no such user, you can't open
tickets from Slack,
and `/docs` and the ticket form only list the projects you can see.
