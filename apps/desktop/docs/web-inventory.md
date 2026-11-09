# Stubwise web SPA (`apps/web`): feature inventory

All paths are under `/Users/aleloca/git/stubwise/.claude/worktrees/desktop-app/`.

**Where routes live.** Routes are defined in code in `apps/web/src/router.tsx` with `createRoute`, not as TanStack file routes. Page components are in `apps/web/src/routes/**`.

**How permissions work.**
- Permissions come from the server: `/api/auth/me` returns `instancePermissions` and `projectPermissions`, and `lib/permissions.ts` reads them with `hasPermission`, `useCan`, `useCanFn` and `useCanOnRepository`.
- `instance.full_admin` grants every permission on every project.
- A project permission checked without a `projectId` means "held in at least one project".
- Many actions are not gated in the client. The server enforces them and returns 403. Below, "(gate: X)" means the client hides the control without X. "(server: X)" means the client always shows it and the server enforces the likely permission.
- Some screens get capability flags in the payload instead: `canWrite`/`canIntervene`/`canInterrupt` on agent sessions, `canRequestCorrection`/`canResume` on the PR cycle, `adoption.canManage`, `canEdit`/`canDelete` on comments, and inbox `item.actions[]`.

**Strings.** UI strings are in `apps/web/src/i18n/locales/en.json` and `it.json` (namespaces listed in `apps/web/src/i18n/index.ts`). That file is the most complete list of labels and states.

**Area 2 (task):** dove vive ora ogni voce di Tickets, Board, Backlog, Projects, Roadmap, brief, registro decisioni e Activity, e il test che la copre, sta in `area2-parity.md` (voci di aree successive marcate «area N»).

---

## Auth (public routes)

### Login — `/login` (`routes/login.tsx`, `components/login-form.tsx`, `components/auth-shell.tsx`)
- Shows: a sign-in card with the tagline "self-hosted · issue tracking · ai pipeline".
- Actions: sign in with email and password.
- States: pending; error. After login you are sent to the second-factor step, or to `/setup` if the instance needs one.

### Second factor — `/login/second-factor` (`routes/login-second-factor.tsx`, `components/security/totp-enrollment.tsx`, `components/security/backup-codes-panel.tsx`)
- Shows: one of two stages (`partialLoginStage`: `second_factor` | `enrollment`).
- Actions:
  - Enter the authenticator (TOTP) code.
  - Switch to "Use a backup code" or back to "Use the authenticator app".
  - "Use a passkey" (WebAuthn).
  - Back to sign in.
  - Enrollment stage: scan the QR code or type the key by hand, then confirm the first code.
  - Then the backup codes panel: download the codes, tick "I saved the codes", Continue.
- States:
  - Locked until a given time after too many wrong codes.
  - Passkey failed.
  - Low backup codes warning, with a link to Settings → Security.
  - "You're signed in."

### Register (invite) — `/register?token=` (`routes/register.tsx`)
- Actions: sign up with the invite token (taken from the URL), email and password.

### Setup (first run) — `/setup` (`routes/setup.tsx`)
- Only reachable when the instance needs setup; otherwise it redirects to `/login`.
- Actions: create the first account (gets maintainer rights) with email, password and confirmation.
- States: password mismatch.

### Reset password — `/reset-password/$token` (`routes/reset-password.tsx`)
- Shows: "Password reset for {email}".
- Actions: set a new password and confirm it.
- States: checking the link; invalid, expired or used link; error with retry; success ("all sessions signed out"), with "Go to sign in".
- The link is created by an admin on the Team page.

### Global guard (`router.tsx` `authedRoute`)
- Not authenticated → `/login`.
- Second factor pending → `/login/second-factor`.
- Setup needed → `/setup`.
- `/` → `/tickets`.

---

## Shell / layout

### App layout (`components/app-layout.tsx`)
- Shows:
  - Sidebar with the wordmark, the inbox bell (unread count) and a search box (⌘K).
  - Navigation, in this order: Inbox, Agents, Mail (badge with the count of open proposals), Calendar, Tickets, Board, Backlog, Projects, Repositories (gate: repos.manage), Monitor (gate: monitor.manage), Release (gate: release.merge), Activity, Documentation, Team, Settings.
  - Footer with the user's avatar and email, and Sign out.
- Mobile: a top bar with a hamburger that opens a nav drawer, plus search and bell.
- Actions:
  - Sign out (clears the cache).
  - Open global search with the button or Cmd/Ctrl+K. Inside a Docs space, Cmd+K opens the docs-scoped search instead.
- Cross-cutting pieces mounted here:
  - `ReauthDialog`: step-up second-factor confirmation, opened when a sensitive action gets a "re-confirm" 403 (`lib/reauth.ts`).
  - The UI language is set from `user.language`.
  - `useInboxUnreadWatcher` keeps the unread count up to date.

---

## Inbox

### Inbox — `/inbox` (`routes/inbox.tsx`, `components/inbox-item.tsx`, `components/inbox-bell.tsx`, `components/question-panel.tsx`)
- Shows:
  - Tabs: "To clear" (open), "Snoozed", "Handled".
  - The open tab is split into "To decide" (items with decision actions) and "To know".
  - Project filter (local state, not in the URL).
  - Load more.
  - Items are marked read automatically when visible (`useMarkVisibleAsRead`).
- Item kinds (`notificationKindSchema`): ticket.created, job.pr_opened, job.pr_closed, job.held, job.plan_review, job.budget_held, review.completed, job.failed, docs.limit_paused, docs.nightly_attention, monitor.alert, monitor.recovered, job.awaiting_input, project.pulse, project.brief, google.proposal, google.proposal_handed, request.created, security.alert.
- Actions (only those the server lists in `item.actions`: approve_plan, reject_plan, relaunch, answer, open, snooze, handled, hand_to_project):
  - **Plan to approve:** Approve plan, or Reject with optional instructions for the next attempt.
  - **Relaunch.**
  - **Hand to the project.**
  - **Agent question (job.awaiting_input):** an inline QuestionPanel with single choice (with a "recommended" option), "Other…" free text, and markdown rendering. "Open" goes to `/agents/job/$jobId?ticketId=`.
  - **Pulse proposal (project.pulse):** pick one proposal and Start, which creates a ticket and launches a run. Outcome lines: "waiting for plan approval" or "planning under way"; "Started by {email}"; links to open the ticket or the backlog.
  - **Google mailbox proposal (google.proposal / google.proposal_handed):**
    - Shows sender, subject, date and signal (decision, request, deadline, blocker, other).
    - Single choice, or multi-select for actions confirmed together ("Create N").
    - Action types: create_backlog_item, create_milestone, update_ticket, comment_ticket, record_decision, choose_project, acknowledge_reminder, and reassign_project (pick a target project).
    - "Show what Stubwise read" toggles the source excerpt.
    - Links to open the thread or the calendar event.
    - "Handed to the project" note; "Decided by X"; outcomes "nothing to do" and "couldn't be completed" (retry with Repropose in Mail).
  - **Generic:** Open (link), Snooze (1 hour / Tomorrow / 3 days), mark Handled.
- States:
  - Empty; load error with retry; skeleton while loading.
  - "awaiting approval", "handled by {email}", "snoozed until {date}".
  - Error codes: already_handled, job_in_flight, plan_not_pending, forbidden, invalid_action, stale, alreadyTaken, targetGone, alreadyProposed.
- Gates: approve/reject are effectively plans.approve, decided by the server. Answering a question is allowed for the run's requester or anyone with plans.approve.

---

## Agents (live and past AI sessions)

### Agents list — `/agents` (`routes/agents/index.tsx`, `components/agent-session/session-row.tsx`)
- Shows two sections: "Working now" (live) and "Finished" (last 14 days).
- Each row shows:
  - Kind: Fix, PR review, Backlog item, Backlog, Docs, Mail, Brief, Report, Refinement.
  - Title, project and ticket number.
  - State (live) or outcome (finished).
  - Elapsed time or time since last event.
  - Current activity, e.g. "is editing X", "is running Y", "is asking a question".
- Actions: filter by project (server side) and by outcome (client side); open a session.
- States: empty live, empty recent, and "not available on this instance" (the API route is missing).

### Agent session — `/agents/$id` (`routes/agents/$id.tsx`, `components/agent-session/*`, `lib/agent-session-stream.ts`)
- Shows:
  - Header: kind, title, project, ticket link, state or outcome, elapsed time.
  - Live transcript over a stream: assistant text and tool cards (Input/Result, collapsible, "truncated" marker), grouped into segments (triage, plan, plan_resume, execute, self_repair, correction, review, plan_summary, failure_summary, pr_summary, intake, estimate, email_classify, docs, brief, daily_report, refine).
  - Segment end markers: ok, failed, timed out. "Stopped by {name}".
  - User inputs with delivery status (pending, delivered, undelivered with a reason).
  - "Load earlier", "New messages" pill, "Reconnecting…".
  - For refinement sessions, a side panel with the backlog item (effort, risk, urgency, design, plan).
- Actions:
  - Composer: Send; "Stop and send" (interrupt first); Stop; Resend an undelivered message.
  - Answer the agent's question inline (SessionQuestion).
  - Close the refinement session, with a confirm dialog.
- Gates and states:
  - Writing needs `detail.canWrite`. The field also appears with `canIntervene` while the session is `working` (agent_sessions.intervene). Stopping needs `canInterrupt`.
  - Messages: "This step can only be watched", "Only a maintainer can write to the agent", "Paused: tell the agent what to do".
  - "Not found (or not visible to you)."

### Session by job — `/agents/job/$jobId?ticketId=` (`routes/agents/by-job.tsx`)
- Resolves the session for a job and redirects to it. If none is recorded, it says so and falls back to the ticket.

---

## Mail & Calendar (personal; Google)

### Mail — `/mail`, `/mail/$source/$id`, `/mail/thread/$threadId?message=` (`routes/mail*.tsx`, `components/mail-workspace.tsx`, `components/mail-reading-pane.tsx`, `components/untrusted-html-frame.tsx`)
- Shows a three-column layout:
  - Mailboxes: "All mailboxes" filter.
  - Conversation (thread) list. Each row shows subject, project, an "N open" proposals badge, and a "To sort" triage badge.
  - Reading pane.
- In a thread, each message shows:
  - Excerpt notice: the cleaned text the classifier saw.
  - Context-message note.
  - Show/hide quoted text.
  - Attachments.
  - "Open the conversation in Gmail".
  - Retention notice (90 days).
- A single message can show its full original, which is fetched from Google or the cache. It is rendered in a sandboxed frame with remote images blocked until you click "Show images".
- Actions:
  - Filter by mailbox; open a thread or message.
  - Read the original on Gmail.
  - **Repropose** (re-run classification for a failed or ignored item, per project).
  - From search results, the matching message is highlighted.
- States: empty; load error; not found; original errors (message gone, token expired, Google unavailable); "Sorted — none of the suggested projects matched".
- Note: the web lists by thread only. The per-message API still exists for mobile.

### Calendar — `/calendar` (`routes/calendar.tsx`, `components/calendar-grid-view.tsx`, `components/calendar-detail-panel.tsx`, `components/calendar-series-sidebar.tsx`)
- Shows:
  - Day, Week (default) and Month grid; Today / Previous / Next; a mini month.
  - Mailbox filter (colour per account).
  - Events seen; declined events are marked.
- Detail panel shows:
  - Time, or "all day".
  - Attendees with their response (accepted, declined, maybe, no reply).
  - Your response; description (sandboxed); location.
  - How to join (Meet link and entry points).
  - Reminders (Google default or custom, minutes before, notification or email).
  - Recurrence text; "Open in Google Calendar"; a declined notice.
- Recurring series (sidebar plus detail): occurrence count and next occurrence. Series are off by default.
- Actions:
  - Configure a series: turn on/off, project, action (create milestone / open backlog item / just remind me), days of lead time, "Act automatically" toggle.
  - Delete a series configuration.
- States: empty ("only appointments matching a project's mail rules show here"), with a link to the project's Mail section; load error; "choose a project before turning on".

---

## Tickets

### Tickets list — `/tickets?projectId&status&type&priority&milestoneId&q` (`routes/tickets/index.tsx`, `components/ticket-filters.tsx`, `components/ticket-row.tsx`, `components/saved-views.tsx`, `components/new-ticket-dialog.tsx`)
- Shows each row as:
  - #number and title.
  - Project, "N repos" badge, source badge (Manual, SDK, API, Slack, Webhook, Widget), ×occurrences, labels.
  - Type, priority and status badges; relative time since last update.
- Infinite scroll with "Load more".
- Filters live in the URL:
  - Text search over title, description and comments.
  - Project.
  - Status: "Active (default)" hides done/closed; "All"; or one status.
  - Type, priority, milestone.
- Actions:
  - **New ticket** (dialog): title, project, type, priority, markdown description. Disabled until a project exists. (server: tickets.create)
  - **Saved views:** save the current filters (name, "Share with team"), apply a view, edit or delete your own views. Shared views from teammates can only be applied.
  - "Show all" from the empty state.
- States: empty; empty with active-only hint; error "view_exists".

### Ticket detail — `/tickets/$id` (`routes/tickets/$id.tsx` plus many components)
- **Header** shows #number, title, status, priority, type, effort (1–5 label), source, project, milestone and ×occurrences. Widget tickets get a "View conversation" link.
  - Actions: Copy .md and Download .md (export with frontmatter, body and plan).
- **Design / Description:** markdown body.
  - Action: Remove design, when a design replaced the original (server: tickets.edit). Hidden when the ticket is closed.
- **Implementation plan:** markdown, plus an "In brief" plain-language summary and the approval status line ("approved by X on D" / "plan changed after approval").
  - Actions: "Approve plan in advance" or "Revoke approval" (gate: plans.approve); Remove plan (server: tickets.edit). Hidden when closed.
  - States: "No plan yet — link one from Claude Code".
- **Original request:** collapsible; shown when a design replaced it.
- **Technical payload:** collapsible SDK/webhook payload viewer.
- **Story of the work** (`components/ticket-history.tsx`): readable timeline with "Show all (N)" and "Latest X of Y".
  - Event kinds: run started, question asked/answered, plan approved/pre-approved/rejected, PR opened, review completed (verdict), changes requested (or cancelled), correction pushed/failed, ticket closed, status changed.
- **AI activity** (`components/ai-job-timeline.tsx`): job timeline with work state, provider (account or API key), start/finish, failure summary, PR link and Show/hide log. Link "Watch the session" or "Replay the session".
- **States and actions on the latest job:**

| Latest job state | What the user sees / can do | Gate |
|---|---|---|
| No job yet (not a review ticket) | "Start AI fix" | server: runs.start |
| held, pr_closed, failed or skipped (not a review ticket, not a held correction) | "Start AI fix" (re-triage) and "Relaunch with instructions" (uses user comments; hint if none) | server: runs.start |
| awaiting_plan_approval | Approve, or Reject with optional instructions (they become a team comment). Without the permission: "Waiting for a maintainer to approve the plan." | gate: plans.approve |
| awaiting_input | QuestionPanel to answer the agent. Others see "Waiting for an answer from {email}". | requester or plans.approve |

  - Operator hint: "the run will stop on the plan" or "already approved: the run will start". After a run: "Started: waiting for approval".
  - Past questions: collapsible list with round, question, answer and who answered.
- **Corrections by Stubwise** (`components/pr-adoption-panel.tsx`), for PRs Stubwise didn't open:
  - States: available, adopted, unavailable (fork, stubwise_pr, base_branch, protected_branch, pr_closed).
  - Actions: "Let Stubwise fix it" (hand over, optional note for the first correction; shows the target branch); "Stop correcting".
  - Gate: `adoption.canManage` (prs.adopt).
- **Repository / PR rows:**
  - Shows repository link, branch, PR state (open, merged, closed) and "View PR".
  - PR correction cycle row (`components/pr-cycle-row.tsx`) shows the state: reviewing, correcting (round X of max), approved/ready to merge, changes requested (by whom, in Stubwise or on the platform), stopped at cap, correction failed, idle, held (budget / limit / other / needs maintainer), queued, blocked on a protected branch.
  - Actions: "Request changes" with an optional note, then Start correction (gate: `cycle.canRequestCorrection`, i.e. corrections.request); "Resume correction" (gate: `cycle.canResume`; a budget hold needs a maintainer).
- **AI usage panel:** total tokens and cost, per model (in, out, cache, cost).
- **Linked tickets** (`components/ticket-links.tsx`):
  - Shows relations: blocks, blocked by, relates to, parent of, child of.
  - Actions: Link ticket (search picker plus relation blocks / relates to / parent); remove a link with confirm. (server: tickets.edit)
- **Attachments** (`components/attachment-list.tsx`, `components/attachment-upload.tsx`):
  - Shows a list with previews.
  - Actions: upload (images, PDF, text or ZIP, up to 10 MB); remove with confirm (server: uploader or tickets.moderate).
  - If storage is off and you have settings.manage, a "Configure storage in Settings" link replaces the upload.
- **Activity feed** (`components/activity-feed.tsx`): comments plus audit events (status, assignee, priority, type, labels, title, body, milestone, relation added/removed) and AI/system comments.
  - Actions: add a markdown comment (server: tickets.comment); reply to a comment (threaded, "in reply to"); edit your own comment (`comment.canEdit`); delete (`comment.canDelete`; moderators via tickets.moderate).
  - States: edited marker; "Comment deleted · by X"; a decision-log note for rejected-plan instructions (can't be rewritten).
- **Sidebar:**
  - Selects: status, priority, assignee (shows avatar; "Assignee without access" warning), milestone.
  - Labels editor: add or remove.
  - All are patches (server: tickets.edit).
  - Meta: created, updated, last seen, occurrences.

### Board — `/board?projectId` (`routes/board.tsx`)
- Shows Kanban columns for each ticket status: open, triaged, in_progress, in_review, done, closed. Cards show #number, title, ×occurrences, repo count and badges.
- Actions:
  - Project filter.
  - Drag and drop to change status (optimistic, rolls back on failure). Pointer, touch and keyboard (Space to pick up, arrows to move, Enter to open).
  - Click a card to open it.
- States: truncated at a limit ("filter by project to see all"); "Move failed" with Dismiss; empty column. (server: tickets.edit)

---

## Backlog (discovery)

### Backlog list — `/backlog?projectId&status&urgency&risk&q` (`routes/backlog/index.tsx`, `components/new-backlog-item-dialog.tsx`)
- Shows cards with title, status, urgency, risk, "requested N times", "≈ similar to X", linked ticket count and source (from ticket / manual). Infinite load more.
- Actions:
  - Filters: search, project, status (active default), urgency, risk.
  - **New item** dialog: title, project, markdown description; it is queued for AI intake. (server: backlog.create)
- States: "Item queued — it will appear in a few minutes" (dismissable); empty; disabled until a project exists.

### Backlog item — `/backlog/$id` (`routes/backlog/$id.tsx`, `components/backlog/refine-session-card.tsx`, `components/work-next-step.tsx`, `components/backlog/modal.tsx`)
- Shows:
  - Header with request count.
  - Metadata selects: status (new, refining, ready, converted, archived), effort E1–E5, risk, urgency, risk note; created and updated dates.
  - Next-step line: clarify, ready to convert, converted with no job, preparing plan, awaiting approval, executing, PR ready, done, needs attention — with "Go to ticket".
  - Design/description and implementation plan, with Remove design / Remove plan buttons.
  - Original request (collapsible).
  - Progress section: plan ready or missing (link to the plan); linked tickets with role (origin / converted).
- Actions (server: backlog.edit):
  - Edit metadata.
  - **AI suggestions:** a box proposing effort, risk, urgency and risk note with reasons ("was X"); Accept all or Dismiss.
  - **Refinement session:** Start session (optional first message), Resume, or Open the session (goes to `/agents/$id`). States: the agent is working, turn queued, ready.
  - **Convert to task** (confirm dialog; creates a ticket; link "View ticket #N").
  - Overflow menu: Copy Markdown, Download .md, Merge into… (search picker with suggested similar items, "+N more"), Archive, Reopen.
- States:
  - Locked notice when converted or archived (editing disabled).
  - "Refinement not available on this instance"; "item closed, the session can't start".

---

## Projects

### Projects list — `/projects` (`routes/projects/index.tsx`, `lib/pulse-line.ts`, `lib/stalled.ts`)
- Shows two groups, "Needs you" and "All projects". Each row has repo count, created date and a pulse line:
  - needs you: N questions / plans / decisions
  - working: title, or N jobs
  - idle for N days
  - all quiet
  - waiting on you / on a maintainer: N PRs to merge
- Also a "Stalled · N" list of tickets with days and reason: to prepare, worked then stopped, interrupted, no work recorded.
- Actions: **New project** (inline name form, then you land on its detail) (gate: projects.create).
- States: empty, with an admin or member hint.

### Project detail — `/projects/$projectId` (`routes/projects/$projectId.tsx`)
- **Header:** name, slug, description, created date.
  - Action: Follow / Unfollow (optimistic; follows drive notification routing).
- **Project settings** (gate: project.settings.manage; otherwise a read-only list) (`components/project-form.tsx`):
  - Name and description.
  - Preferred AI account (Automatic, or a specific provider; the provider list needs ai_providers.manage) and "Use only this account".
  - Toggles: Docs updated every night, Daily activity report, Discovery backlog, Proactive pulse (plus days between pulses; needs the backlog), Weekly brief.
  - Max automatic PR corrections (0 means off).
  - Save.
- **Repositories:** list with provider badge.
  - Action: "+ Add repository" (gate: repos.manage).
  - Empty-state hints.
- **Members** (`components/project-members-section.tsx`): list with role in the project.
  - Actions: change role, remove (confirm), add member (user plus project role) (gate: project.members.manage).
- **Integration** (`components/integration-panel.tsx`, visible to all):
  - Ingestion key, DSN and an `init()` snippet, each copyable.
  - SDK install guide for an AI agent: copy or download .md.
  - Inbound generic webhook URL, auth header and example payload (copy).
  - Git webhook URL and secret (copy).
- **Support widget** (`components/widgets-section.tsx`, `components/widget-section-filter.tsx`), visible to all; editing needs widget.manage:
  - Widget list (enabled or disabled, conversation count).
  - New widget / Edit:
    - Name, enabled, daily message cap, daily ticket cap.
    - Knowledge sources: repositories, optionally limited to doc sections/pages through a tree picker. Warnings for empty sources or internal docs.
    - Display title, welcome message, assistant instructions, accent colour, language.
  - Copy embed snippet; copy or download install guide; Delete widget (confirm).
  - Link to "Widget conversations".
- **Mail routing rules** (`components/project-email-routes-section.tsx`), visible to all; editing needs project.settings.manage:
  - Rules: senders/recipients (domain or address), Gmail labels (pick from observed labels or type one), keywords.
  - Note that rules decide attribution only; admission is set in Settings → Google.
- **Servers** (`components/project-servers-section.tsx`): monitored servers linked to the project, with a "Manage in Monitor" link.
- **Environments** (`components/project-environments-section.tsx`), editing needs environments.manage:
  - List: name, kind (test / staging / production), URL, connected server, and the running version "image @ commit" reported by the monitor agent.
  - Add an environment (name, kind, URL, server) or delete one. The test environment can't be deleted.
- **Plugins** (gate: project.settings.manage) (`components/project-plugins-section.tsx`):
  - Per registry plugin: "Enabled in this project", plus toggles for its skills and hooks.
  - "Apply recommended preset".
  - Warnings: not materialized, inventory changed, registry changed. A different message shows when the user lacks plugins.manage.
- **Milestones** (`components/milestone-manager.tsx`, `components/milestone-progress.tsx`):
  - List with status (open or closed), progress (done/total) and due date.
  - Actions: create (name, description, due date), rename/edit, close or reopen, delete (confirm). (server: tickets.edit or project settings)
  - Link to the Roadmap.
- **Danger zone** (gate: project.settings.manage): Delete project, with confirm; cascades to repositories, tickets and docs.

### Roadmap — `/projects/$projectId/roadmap` (`routes/projects/$projectId.roadmap.tsx`, `components/project-timeline.tsx`)
- Shows:
  - Open milestones: progress, due date, "overdue".
  - Timeline grouped by week. Entries: ticket opened or closed, milestone due or closed, PR opened / merged / closed (with review verdict), daily report, decision (who decided), weekly brief (period).
- Actions: filter by type (Tickets, PRs, Milestones, Daily reports, Decisions, Weekly briefs); open a PR or a brief.
- States: empty ("widen the window or clear filters"), loading, error.

### Weekly brief — `/briefs/$id` (`routes/briefs/$id.tsx`)
- Shows: period, generated date, and the plain-language summary.
- Actions: "Copy as text"; Regenerate (gate: project.settings.manage).
- States: pending; failed; no text (no usable AI provider).

### Widget conversations — `/projects/$projectId/conversations?widgetId&conversationId&ticketId` (`routes/projects/widget-conversations.tsx`)
- Shows: list of conversations (widget name or "deleted widget", message count, ticket count) and a detail pane (email, external ID, user and assistant messages with cited sources, "View ticket").
- Actions: filter by widget; select a conversation. Deep link from a widget-origin ticket.

---

## Repositories

### Repositories list — `/repositories` (`routes/repositories/index.tsx`); in nav with repos.manage
- Shows: repositories grouped by project, with branch.
- Actions: Add repository (gate: repos.manage).

### Add repository — `/repositories/new` (gate: repos.manage; project picker limited to projects where you hold it) and `/projects/$projectId/repositories/new` (gate: repos.manage on that project) (`components/repository-wizard.tsx`)
- Actions:
  - Pick a git account (links to Settings → Git accounts if there is none).
  - Search and pick a repository from the account; if the list isn't available, enter URL and branch by hand.
  - Pick the default branch (`components/branch-select.tsx`).
  - "Verify repository access" (advisory check of push, PR and webhook permissions).
  - Optional test command and install command.
  - Submit.
- States: after save, warnings (`components/repository-save-warnings.tsx`): main account identity unresolved, default reviewer invalid.

### Repository detail — `/repositories/$slug` (`routes/repositories/$slug.tsx`, `components/repository-form.tsx`, `components/webhook-config-panel.tsx`, `components/project-env-files-section.tsx`)
- Shows: "✓ configured correctly" banner and a "back to project" link. Without repos.manage, a read-only view (name, URL, branch, git account, webhook status).
- Actions (gate: repos.manage):
  - Edit: name, URL, default branch, git account, review account (Default / none / a specific one, with the effective reviewer explained), test and install commands, "Code knowledge graph" toggle, protected branches (one per line, `*` as prefix wildcard).
  - Webhook panel: Configure automatically / Reconfigure.
  - **Environment files:**
    - Files per environment: add file (path), delete file.
    - Import variables by pasting `KEY=value` lines or uploading a .env.
    - Per variable: Replace value (write-only) or Remove.
    - The note says whether the fix pipeline reads it (test environment only).
- "Open documentation" link.

---

## Documentation

### Docs hub — `/docs` (`routes/docs/index.tsx`)
- Shows: projects, each with its repository spaces (page count, "generated {date} at {commit}", "manual pages only", "not generated yet").
- Actions: open project documentation; open a repository space.

### Project docs landing — `/docs/project/$projectId` (`routes/docs/project.$projectId.tsx`, `components/docs-chat.tsx`)
- Shows:
  - Brief identity.
  - "Start here": project brief link and main repository overview.
  - All repository spaces.
  - Decisions summary, with "See the whole register".
  - "What's new" (recent releases, with a minor badge).
- Actions: **project-wide docs chat** (RAG across all repos, citations name the source repo, suggested questions, New chat).
- States: chat unavailable (needs an API-key provider).

### Decision register — `/docs/project/$projectId/decisions` (`routes/docs/project.$projectId.decisions.tsx`)
- Shows: decisions with title, decision, context, consequences, ticket link, decided by, and a superseded flag.
  - Sources: agent question, plan review, pulse proposal, by hand. `email` also exists in the schema.
- Actions:
  - Filter by source.
  - Set "Superseded by" (select another decision or none).
  - **Record a decision** form: title, decision, context (and consequences). (server: decisions.record)
- States: loading, error, empty.

### Docs space (per repository) — `/docs/$projectId` (the param is a repository id) (`routes/docs/$projectId.tsx`, `components/docs-sidebar.tsx`, `components/docs-tree.tsx`, `components/docs-generation-panel.tsx`, `components/docs-search-trigger.tsx`)
- Layout:
  - Sub-bar: Index, back to Documentation, Chat toggle.
  - Resizable sidebar with links to Project brief, Releases (with count) and Graph.
  - Tree grouped by Technical / Functional / Product / Manual: collapse or expand each node or all; download a category as a .md zip.
  - Generation panel at the bottom.
  - Resizable chat panel: repository-scoped RAG with sources.
  - Cmd+K opens search scoped to this repository, with a toggle to widen to everything.
- **Generation panel:**
  - Status: never, queued, running, succeeded, failed, held, or paused on a usage limit.
  - Last generated, commit, cost, pinned provider, failure reason.
  - Actions: Generate documentation and Resume now (gate: docs.generate on the repository's project); "+ New manual page".
- Sub-routes:
  - `/docs/$projectId/` (index, `components/docs-repo-overview.tsx`): repo brief summary, "Start here", categories, what's new, recently updated, most read (from view pings).
  - `/docs/$projectId/$slug` (page):
    - Markdown page with meta badges: "documents {path}", "generated at commit X" (links to the commit), "updated on", "manual page".
    - Stale warning listing commits made after the page was last updated.
    - Related links: implements, implemented by, related.
    - Manual pages: Edit and Delete (confirm). (server: docs.edit)
    - State: page not found.
  - `/docs/$projectId/new`: manual page form (title, optional slug, markdown body); slug-conflict error. Edit uses the same form. (server: docs.edit)
  - `/docs/$projectId/brief` (`routes/docs/brief.$projectId.tsx`), the repository's project brief:
    - Sections: Identity, Actors, Surfaces (audience), Glossary, Business invariants, User journeys, Existing sources.
    - Confidential facts detected (fact, reason, where in the code, must not appear as), shown for audit.
    - Pages excluded from the public docs, with reason.
    - States: empty or error.
  - `/docs/$projectId/releases` (`components/docs-releases.tsx`): changelog entries written nightly.
    - Actions: search; "Significant only" filter; minor badge; impacted pages.
  - `/docs/$projectId/graph` (`routes/docs/graph.$projectId.tsx`), code knowledge graph (graphify):
    - States: disabled (explainer; "Enable it in the repository" needs repos.manage, others are told to ask a maintainer); never generated; queued/running (auto-refresh); failed (reason, Retry); ready.
    - Ready shows: node, edge and community counts; AI labels; "updated on push"; interactive graph (expand/close); communities report; Download graph.json; copyable `graphify query` command.
    - Actions (gate: repos.manage): Generate, Regenerate, Rebuild from scratch, Open setup PR / View the setup PR.

---

## Release

### Release queue — `/release` (route requires release.merge in any project; nav is gated too) (`routes/release.tsx`)
- Shows every open PR on connected repositories:
  - Ticket and repository.
  - "External" badge (opened outside Stubwise).
  - Review verdict (approved / changes requested / none, with a stale marker).
  - Checks (green, red, running, none, unreadable).
  - Test status (passed, failed, skipped, unknown, not run by Stubwise).
  - Risk (low, medium, high, unknown).
  - "Already on" (deployed environments).
- Actions: Release, then Confirm merge.
- States: empty; errors alreadyClosed, checksFailed, checksUnreadable, notMergeable, mergeForbidden, notFound.
- Stubwise never deploys.

---

## Monitor

### Monitor list — `/monitor` (nav gate: monitor.manage; the route has no guard, and monitor.view exists) (`routes/monitor/index.tsx`, `components/server-card.tsx`, `routes/monitor/server-admin.tsx`)
- Shows server cards: status (online, offline, never connected), CPU sparkline, services up/down, last seen, agent version.
- Actions (gate: monitor.manage):
  - New server (name), then a one-time key panel with the install command: Docker steps, verify steps, copy command, full-guide link.
- States: empty.

### Server detail — `/monitor/servers/$serverId` (`routes/monitor/server-detail.tsx`, `routes/monitor/metrics-charts.tsx`, `routes/monitor/uplot-chart.tsx`, `routes/monitor/services-table.tsx`, `routes/monitor/disks-panel.tsx`, `routes/monitor/checks-table.tsx`, `routes/monitor/thresholds-panel.tsx`)
- Shows:
  - Linked projects; last seen; stale-snapshot warning.
  - Range selector: 1h, 24h, 7d, 30d, 90d.
  - Charts: CPU % (and max), load 1m, RAM, disk, network in/out, latency. "Truncated" and "no data" states.
  - Services table: name, state, CPU, RAM, restarts. Source is docker or pm2.
  - Disks: used/total against the threshold.
  - Checks table: name, type, target, status (up, down, unknown), latency, down since. Selecting a check shows its latency chart.
- Actions (gate: monitor.manage):
  - Checks: add or edit (name, type http/tcp/process/postgres/mysql, target; database DSN is encrypted and write-only; interval; enabled) and delete.
  - Alert thresholds: CPU %, memory %, disk %, sustained minutes (blank disables).
  - Server settings: name, linked projects, sample interval; Regenerate key (confirm; reveals the new key); Delete server (confirm).

---

## Activity

### Activity (daily standup) — `/activity?date` (`routes/activity.tsx`)
- Shows:
  - Date picker with previous and next day.
  - Tabs "By project" and "By developer", with commit, author and project counts.
  - Collapsible blocks; per-commit AI description (expand/collapse); summary (or "in progress").
  - Unresolved git identities ("Unknown author").
  - Report status: queued, running, done, failed.
  - Stale warning: "N new commits not included".
- Actions:
  - "Generate report for this day" and Regenerate (gate: settings.manage).
  - "Link team member" for an unresolved git email (member picker) (gate: users.manage).
- States: no report for the date; no enabled projects; no activity; load error.

---

## Team

### Team — `/team` (`routes/team.tsx`)
- **Members:** email, avatar, instance role badge (full-admin highlighted), member since, "you" marker. Linked identities: Slack (name), Git emails (count), Bitbucket username.
  - Actions:
    - Change instance role (gate: users.manage; not on yourself).
    - Link or unlink Slack identity, via a Slack member picker with search (gate: integrations.manage); hint "Configure Slack in Settings".
    - Link git author emails (picker or typed email) and unlink them (gate: users.manage).
    - Link or unlink Bitbucket username (gate: users.manage).
    - Reset password: creates a single-use link that expires, shown with a copy button and Close (gate: users.manage; not yourself).
    - Reset 2FA, with a confirm dialog (gate: users.manage; not yourself).
    - View a member's security log (gate: users.manage).
- **Pending invites** (gate: users.invite):
  - Create invite: email, instance role (default User), plus project grants (project and project role, limited to projects where you have project.members.manage; add or remove rows).
  - Copy invite link ("deliver it yourself"); "Invite from Slack".
  - List shows sent, expires and expired dates; Revoke (confirm).

---

## Settings — `/settings/*` (`routes/settings/layout.tsx`)
The sub-nav is filtered by permission. `/settings` redirects to `/settings/account`. A route without permission redirects to `/settings/account`.

### Account — `/settings/account?google=<outcome>` (always) (`routes/settings/account.tsx`, `components/google-accounts-section.tsx`)
- Shows: email; role badge (Maintainer if full admin, otherwise Operator).
- Actions:
  - **Language** (English or Italiano; persisted on the server).
  - **Followed projects:** checkbox per project, saved immediately.
  - **Notifications:** Slack DM toggle (needs a linked Slack account); push notifications on the mobile app toggle.
  - **Google mailboxes:** consent notice; Connect a mailbox (pick a Workspace, then "Continue on Google" OAuth). Each mailbox shows active or disabled with a reason (revoked, invalid_grant, insufficient_scope, workspace_removed, sync_failed) and last sync. Actions: Reconnect; Disconnect (confirm); "Proposals on for this mailbox" toggle.
    - OAuth outcomes: ok, domain_mismatch, no_refresh_token, insufficient_scope, email_not_verified, mailbox_owned_by_other, error.
  - **Change password:** current, new, confirm. Other sessions and the mobile app are signed out.

### Security — `/settings/security` (always) (`routes/settings/security.tsx`, `components/security/*`)
- Two-step verification is mandatory and can't be turned off.
- Actions:
  - Authenticator app: Set up or Reconfigure (QR plus confirm).
  - Passkeys: list (name, added, last used); add (name plus browser WebAuthn); rename; remove (confirm).
  - Backup codes: remaining count (low warning); Regenerate (confirm; codes shown once, Download).
  - Security log: events login, enrolled, totp_reconfigured, passkey_added, passkey_removed, backup_codes_regenerated, backup_code_used, locked, second_factor_reset, password_reset_link.

### Access tokens — `/settings/access-tokens` (always) (`routes/settings/access-tokens.tsx`)
- Shows: table with name, created, last used, expires (or expired).
- Actions: create (name, optional expiry date in the future); the token is revealed once (copy, Done, MCP/STUBWISE_TOKEN hint); Revoke (confirm).

### Claude Code — `/settings/claude-code` (always) (`routes/settings/claude-code.tsx`, `lib/sdk-install-guide.ts`)
- Shows prerequisites (Claude Code, Node 22+, shell notes).
- Actions: "Create the command", a one-shot installer with an embedded personal token, shown once (copy).
- Also shows suggested prompts: "How does…", "I found a problem…", "I wish I could…", "Where are my requests at?"

### AI automation — `/settings/automation` (gate: settings.manage) (`routes/settings/automation.tsx`, `components/model-settings-section.tsx`)
- Per ticket type: Auto-fix toggle, effort threshold, "Plan approval from effort ≥" (or Never), max cost per ticket ($).
- PR Review: enabled, max cost per review.
- **Models:** model per AI operation, instance-wide (Default or a specific model):
  - Tickets: triage, fix plan, fix execution, PR review, summaries.
  - Backlog: intake, refinement.
  - Nightly: commit summaries, release notes, nightly Docs.
  - Docs: generation.
  - Reports: daily report, weekly brief.
  - Mail: classification.
  - Chat: docs chat, backlog merge.

### Notifications — `/settings/notifications` (gate: settings.manage) (`components/notifications-section.tsx`)
- Outgoing webhook: enabled; format (Slack, Discord, Generic JSON); URL.
- Event toggles: new SDK ticket, PR opened, PR closed, on hold, plan awaiting approval, budget exceeded, review completed, fix failed, docs paused / nightly attention, monitoring alerts, AI question, proactive pulse, weekly brief.
- Save; Send test notification; Preview of sample messages.
- Per-format setup guides (Slack, Discord, generic payload schema).
- **Generated content language** (EN or IT, for AI comments, PR reports and notifications).
- **Monthly AI budget ($):** jobs are held once it is exceeded.

### Usage & costs — `/settings/usage` (gate: usage.view or project.usage.view) (`routes/settings/usage.tsx`, `components/usage-panel.tsx`)
- Period: last N days, current month, or custom from/to.
- Totals: cost, input tokens, output tokens, cache read, runs.
- Tables by day, model, project and provider.
- Breakdown: group by operation, project, model or day, then by a second dimension. Columns: runs, in, out, cache read, cache creation, cost, avg per run.
- Technical operations (plugin smoke run, credential test, usage probe) are labelled separately.

### Git accounts — `/settings/git-accounts` (gate: git_accounts.manage) (`components/git-accounts-section.tsx`, `components/credential-fields.tsx`)
- List of accounts.
- Actions:
  - Create or edit: name, provider (bitbucket or github), Bitbucket workspace, username, email, token (write-only).
  - Validate (valid, or issues found).
  - Delete (blocked while the account is in use).
  - **Default reviewer** toggle, with replace-confirm and per-repository warnings.

### Storage — `/settings/storage` (gate: settings.manage) (`components/storage-section.tsx`)
- S3-compatible storage: endpoint, region, bucket, access key, secret (write-only; Remove stored secret).
- Badge: attachments enabled or disabled.

### Slack — `/settings/slack` (gate: settings.manage) (`components/slack-section.tsx`)
- Signing secret and bot token (write-only; remove buttons).
- Setup hint: slash-command URL, interactivity URL and required scopes. DM buttons: approve plan, relaunch, snooze.
- Badge: enabled or disabled.

### Google — `/settings/google` (no route guard)
- **Google Workspaces** (`components/google-workspaces-section.tsx`, gate: integrations.manage):
  - Create or edit: name, email domains, client ID, client secret (write-only).
  - Each workspace shows secret set or missing and connected mailbox count.
  - Delete (blocked while mailboxes are connected).
  - Console instructions: redirect URI and scopes.
- **Admitted mail** (`components/mail-admission-section.tsx`): visible to all; editing needs settings.manage. The domain list needs integrations.manage.
  - "Admit mail from registered Workspace domains" toggle, with the domain list.
  - Gmail labels always excluded.
  - "Discard automated mail" toggle.

### AI providers — `/settings/ai-providers` (gate: ai_providers.manage) (`components/ai-providers-section.tsx`)
- An ordered failover chain of providers.
- Actions:
  - Create: kind (API key or Account `setup-token`), label, secret (write-only).
  - Enable or disable; Move up or down; Test (working / failed); Delete.
- Warning when several Account credentials exist (Anthropic Terms of Service).
- Subscription usage for Account providers: session and weekly % remaining, reset time, estimated flag. Show raw output and a diagnostic when parsing fails.

### Plugins — `/settings/plugins` (gate: plugins.manage) (`components/plugins-section.tsx`, `components/plugin-inventory.tsx`)
- Register a plugin: source URL, ref, optional subdirectory. Slug-taken error.
- Each plugin shows:
  - Status: waiting, materializing, ready, failed (with error).
  - Smoke test: running, passed, failed.
  - Ref and pinned SHA.
- Actions: Update to ref…; Retry smoke; Remove (confirm).
- Inventory: skills (with size), commands, agents, hooks (matcher); note that a present `.mcp.json` is ignored.
- Diff of inventory changes in the latest revision.

### Roles — `/settings/roles` (gate: roles.manage) (`routes/settings/roles.tsx`, `lib/permission-groups.ts`)
- Instance roles and project roles, each list showing preset badge, permission count and assignment count.
- Actions:
  - New role; Edit (name plus permission checkboxes grouped: Administration, People, Projects, Integrations, Monitoring and usage, Project, Tickets, AI runs and releases, Backlog and decisions, Docs, Code and environments).
  - Duplicate; Delete (confirm). System presets can be edited but not deleted; roles in use can't be deleted.
  - "Full administration includes every permission" hint.

---

## Cross-cutting

- **Global search / command palette** (`components/global-search-palette.tsx`, ⌘K or the sidebar box or the mobile icon):
  - Groups: Tickets, Projects, Repositories, Documentation, Mail ("The matching message").
  - Fast full-text search (150 ms debounce), then semantic docs enrichment (600 ms, "Refining…").
  - Recent searches, stored on the server: Clear all, or remove one.
  - Show more per group; keyboard navigate, open, close.
  - In a Docs space, scope "This documentation" or "Everything" (Tab).
  - This is a search palette, not a command palette: there is no action command palette.
- **Inbox bell:** unread count, in the sidebar and the mobile top bar. Slack DMs with action buttons, and mobile push, mirror the inbox.
- **Mail nav badge:** count of open proposals.
- **Step-up re-authentication** (`components/security/reauth-dialog.tsx`, `lib/reauth.ts`): a modal opens on a re-confirm 403. You enter TOTP, or enroll on the spot (QR, then backup codes). The original request is then retried.
- **i18n:** English and Italian (`i18n/locales/en.json`, `it.json`; a parity test keeps them in sync).
  - Before login the language follows the browser (`it` if the browser is Italian, else `en`). After login it follows `user.language`.
  - API errors are translated by `code` (`lib/translate-api-error.ts`, `errors` namespace).
  - The generated-content language is a separate instance setting.
- **Theming:** one dark theme ("ink/signal" tokens in `styles.css` `@theme` and `packages/shared/src/design-tokens.ts`). There is no theme toggle.
- **Responsive:** mobile drawer navigation, touch targets of about 44px, board touch sensors.
- **Live updates:**
  - Agent session stream with a reconnecting state.
  - Polling on job, inbox and graph status.
  - View pings for docs "most read" (`lib/use-view-ping.ts`).
- **Markdown everywhere:** `components/markdown.tsx` for rendering; `components/markdown-editor.tsx` with Write/Preview, bold, italic, code, link and list.
- **Untrusted HTML:** sandboxed iframe with remote images blocked by default.
- **Exports and copy:** ticket and backlog item as .md (copy or download); docs category zip; graph.json; SDK and widget install guides (.md); backup codes download; brief copy as text. Copy has a manual fallback.
- **Error handling:** `components/route-error.tsx` for route errors; inline error messages; translated API error codes. "Not available on this instance" degradations for older servers.
- **Integrations that create tickets:** SDK (sdk_error, sdk_feedback), API, Slack slash command, inbound generic webhook, support widget. A git webhook moves the ticket to done on merge.
- **Permissions model:**
  - Instance permissions: instance.full_admin, projects.create, users.invite, users.manage, users.view_all, roles.manage, settings.manage, ai_providers.manage, git_accounts.manage, git_accounts.view, plugins.manage, integrations.manage, monitor.view, monitor.manage, usage.view, mail_admission.view.
  - Project permissions: project.settings.manage, project.members.manage, project.usage.view, tickets.view_all, tickets.create, tickets.edit, tickets.comment, tickets.moderate, runs.start, plans.approve, release.merge, corrections.request, backlog.view_all, backlog.create, backlog.edit, docs.view, docs.edit, docs.generate, repos.view, repos.manage, agent_sessions.intervene, decisions.record, environments.manage, widget.manage, prs.adopt.
  - Preset roles: instance Admin (full_admin) and User; project Project Lead (all), Developer (all except plans.approve, release.merge, project.members.manage, project.settings.manage), Contributor (docs.view, tickets.create, tickets.comment, backlog.create), Viewer (view permissions only), Legacy Member.
  - Source: `packages/shared/src/permissions.ts`.

---

## Entities (from `packages/shared/src/schemas/*`)

**Ticket and its jobs**

| Entity | Fields / enums |
|---|---|
| Ticket (`ticket.ts`) | status: open, triaged, in_progress, in_review, done, closed. type: bug, feature, task, feedback, review. priority: low, medium, high, urgent. source: manual, sdk_error, sdk_feedback, api, slack, webhook, widget. effort 1–5 (Trivial, Small, Medium, Large, Very large). Also: labels, assignee, milestone, occurrences, lastSeenAt, technicalPayload, body (design), originContent, implementationPlan, planSummary, planApprovedAt/By, planApprovalStale, assigneeWithoutAccess, repositories[] (branch, prState: open, merged, closed_unmerged, prUrl, cycle), prAdoption. |
| Comment | authorType: user, ai, system. Supports reply, edit and soft-delete. |
| Ticket history actor | user, ai, system, provider. |
| Ticket link kinds | blocks, blocked_by, relates_to, parent, child. |
| Ticket activity events | status_changed, assignee_changed, unassigned, priority_changed, type_changed, labels_changed, title_changed, body_changed, milestone_changed, relation_added, relation_removed. |
| AI job (`ai-job.ts`) | status: queued, triaging, fixing, held, pr_opened, pr_merged, failed, skipped, pr_closed, awaiting_plan_approval, awaiting_input. heldReason: limit, budget, other. Run response status: queued, awaiting_plan_approval. |
| AI provider kind | api_key, account. |
| WorkState (`work-state.ts`, display) | proposed, planning, working, held, waiting_answer, waiting_approval, pr_ready, done, failed, skipped, rejected. |
| PR correction (`pr-correction.ts`) | trigger: review, stubwise, provider. Cycle state: reviewing, correcting, approved, changes_requested, stopped_at_cap, correction_failed, idle. Stop reason: cap, review_failed. blockedReason: adopted_branch_protected. Adoption state: available, adopted, unavailable. Unavailable reason: fork, stubwise_pr, base_branch, protected_branch, pr_closed. |
| Agent question / answer | Rounds; options with a recommended one; free text; multi-select indices. |

**Backlog**

| Entity | Fields / enums |
|---|---|
| Backlog item (`backlog.ts`) | status: new, refining, ready, converted, archived. risk: low, medium, high. urgency is a ticket priority. source: ticket, manual. effort 1–5. Also: riskNote, requestCount, similarTo, suggested fields. Ticket role: origin, converted_to. |
| Backlog job | kind: intake, estimate. status: queued, running, done, failed. |
| Refinement session | status: active, closed. Close reason: user, idle, item_closed. |
| Next step (`next-step.ts`) | clarify, readyToConvert, convertedNoJob, preparingPlan, awaitingApproval, executing, prReady, done, needsAttention. |

**Agent sessions**

| Entity | Fields / enums |
|---|---|
| Agent session (`agent-session.ts`) | kind: ai_job, pr_review, backlog_item, backlog_job, doc_generation, email_message, project_brief, daily_report, backlog_refine. state: queued, working, waiting_input, awaiting_approval, held, idle, ended. outcome: completed, failed, skipped. |
| Session segment label | triage, plan, plan_resume, execute, self_repair, correction, correction_self_repair, review, plan_summary, failure_summary, pr_summary, intake, estimate, email_classify, docs, brief, daily_report, refine. |
| Session event type | segment_start, assistant_text, tool_use, tool_result, input, turn_end, segment_end. |
| Activity kind | edit, read, run, search, web, ask, subagent, write, other. |
| User input | status: pending, delivered, undelivered. Reason: session_not_live, stdin_closed, turn_failed, budget_exceeded. |

**Inbox, mail and calendar**

| Entity | Fields / enums |
|---|---|
| Inbox / notification (`notification.ts`) | kinds as listed in the Inbox section. status: open, handled, snoozed. actions: approve_plan, reject_plan, relaunch, answer, open, snooze, handled, hand_to_project. snooze: 1h, tomorrow, 3d. Google action types: create_backlog_item, create_milestone, update_ticket, comment_ticket, record_decision, choose_project, acknowledge_reminder, reassign_project. Review outcome: approved, changes_requested, stopped_at_cap, review_failed. Proposal decision status: actioned, ignored, failed. |
| Mail item (`google.ts`) | source: email, calendar (thread sources email, email_triage). kind: proposal, triage, calendar. status: new, classified, proposed, actioned, ignored, failed, cancelled. signal: decision, request, deadline, blocker, none. Rejection reason: automated, denied_label, no_match. Body source: google, cache. |
| Email route (project mail rules) | sender_domain, sender_address, gmail_label, keyword. |
| Calendar | Series action: backlog_item, milestone, reminder. Attendee response: needsAction, declined, tentative, accepted. |
| Google mailbox | Active/disabled, with disabled reasons revoked, invalid_grant, insufficient_scope, workspace_removed, sync_failed. Google Workspace has domains and a client ID/secret. |

**Projects, docs and decisions**

| Entity | Fields / enums |
|---|---|
| Project (`project.ts`) | aiProviderId, aiProviderExclusive, docAutoUpdate, dailyReportEnabled, backlogEnabled, pulseEnabled, pulseEveryDays, weeklyBriefEnabled, prCorrectionMaxRounds, ingestionKey, slug. Pulse waiting kind: question, plan_approval. Waiting-who kind: requester, maintainer. Stalled reason: to_prepare, worked_then_stopped, interrupted, declared_no_work. Timeline kind: ticket_opened, ticket_done, milestone_due, milestone_closed, pr_opened, pr_merged, pr_closed, report_day, decision, brief. PR review: status running, completed, failed; verdict approve, request_changes. Daily report: queued, running, done, failed. |
| Decision | source: ask_user, plan_review, pulse, manual, email. Fields: title, context, decision, consequences, decidedBy, supersededBy, ticket. |
| Repository | provider: bitbucket, github. Warnings: main_account_identity_unresolved, default_review_account_invalid. Also protected branches, review account, test and install commands, graph enabled. |
| Milestone | status: open, closed. Also name, description, dueDate, progress. |
| Environment | kind: test, staging, production. Env files and variables are write-only. |
| Doc page (`docs.ts`) | kind: technical, functional, product, manual, releases. Tree: technical, functional, product. Link types: implements, implemented_by, related. Search source: semantic, fulltext, hybrid. |
| Doc generation | status: pending, running, paused, succeeded, failed. trigger: manual, push. |
| Doc job | queued, running, succeeded, failed, held. |
| Doc node | pending, exploring, awaiting_children, ready_to_synthesize, synthesizing, done, failed. |
| Search entity (history) | ticket, project, repository, doc. |

**Release, widget, monitoring**

| Entity | Fields / enums |
|---|---|
| Release item (`release.ts`) | review verdict: approve, request_changes. Check outcome: success, failure, pending (plus no checks / unknown in the UI). Test status: passed, failed, skipped. Risk: low, medium, high. Origin: stubwise, external. |
| Widget (`widget.ts`) | ticket type: bug, feedback, feature. language: it, en. Also caps, sources and section filters. Widget conversations contain messages and tickets. |
| Server / monitoring (`server.ts`) | status: online, offline, never_connected. Check type: http, tcp, process, postgres, mysql. Check status: up, down, unknown. Service source: docker, pm2, pm2_fallback. Alert thresholds: cpu, mem, disk %, sustained minutes. |

**Plugins, AI, users and security**

| Entity | Fields / enums |
|---|---|
| Plugin (`plugin.ts`) | status: none, materializing, ready, failed. Smoke: idle, pending, passed, failed. Job kind: materialize, smoke. |
| AI operation (`ai-operations.ts`) | triage, fix_plan, fix_execute, pr_review, summary, backlog_intake, backlog_refine, commit_summary, release_notes, docs_nightly, docs_generation, daily_report, weekly_brief, mail_classify, chat, backlog_merge, plugin_smoke, credential_test, usage_probe. Model aliases: opus, sonnet, haiku, plus explicit model ids. |
| User (`user.ts`) | legacy role: admin, member. language: en, it. Also instance role, avatar, Slack, git and Bitbucket links. |
| Role (`roles.ts`) | scope: instance, project. Permissions as listed under Cross-cutting. |
| Security (`second-factor.ts`) | partial login stage: second_factor, enrollment. Security event kinds as listed under Settings → Security. |
| Personal access token (`pat.ts`) | name, expiry, last used. |
| Push device (`push.ts`) | platform: ios, android (mobile only). |
| Saved view | name, filters (projectId, status, type, priority, milestoneId, q), shared. |
| Invite | email, instance role, project grants, expires. |
| Password reset link | single use, expires. |
