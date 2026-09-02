---
title: Plugins and skills
description: The instance registry of Claude Code plugins, how they enter the agent's runs, what Stubwise refuses to load, and the recommended preset for superpowers.
---

The agent that plans and fixes your tickets is the `claude` CLI. **Plugins** are
the standard way to give that CLI extra **skills, commands, subagents and
hooks** — a methodology for brainstorming, a house style for tests, a checklist
before a refactor.

Stubwise has an **instance registry**: an admin registers a plugin once, and it
becomes enableable on any project. Nothing is loaded that an admin has not put
there on purpose.

## Registering a plugin

**Settings → Plugins**, admin only. A plugin is a **public `https://` git repo**
plus a **ref** (a tag, a branch or a commit) and, optionally, the subdirectory
that holds it.

What happens next is automatic:

1. The worker **fetches the ref and pins it to the commit it resolves to**. From
   that moment the plugin is that exact commit: a moved tag or a new push on the
   branch changes nothing until an admin clicks **Update to ref…**.
2. It validates the tree (`claude plugin validate --strict`) and builds an
   **inventory**: every skill with its description and the size of its
   `SKILL.md`, every command, every subagent, and every hook **with the command
   it runs**.
3. It runs a **smoke test**: a one-turn run of the real CLI with the plugin
   loaded, which passes only if every skill in the inventory is actually visible
   to the agent, namespaced as `plugin-name:skill-name`.

The page shows the pin, the status, the smoke result and, on an update, what
changed in the inventory since the previous revision.

## Enabling a plugin on a project

**Project → Plugins**, admin only. A registered plugin does **not** run
anywhere until it's enabled on a project, and enablement is per project: two
projects can run different sets.

Within an enabled plugin the model is **subtractive** — everything is on, and
you turn off what you don't want, skill by skill and hook group by hook group.
The list is the inventory, so you're choosing from what the plugin really
contains at the pinned commit, not from a description of it.

:::caution[With plugins on, the target repository's `.claude/settings.json` is ignored]
A run that loads plugins also runs with **all other settings sources off**, so
that what the agent loads is exactly "Stubwise's plugins and nothing else"
instead of whatever happens to be in the repo or on the host.

This changes nothing for **fix runs**: they already ran from the parent
directory of the checkouts, so a repository's `.claude/settings.json` was never
loaded in the first place. It **does** change **deep dive** runs and **backlog
analysis sessions**, which run from the repository root: with plugins enabled on
the project, those stop loading the repository's `.claude/` configuration.
:::

### Which runs load plugins

Fix runs (planning, planning resume, execution, self-repair), backlog **deep
dives** and backlog **code-analysis chats**. Triage, backlog intake and
estimation, documentation generation, PR review, daily reports and credential
tests do **not** load plugins: they are short, cheap, and gain nothing from a
methodology skill.

## The Stubwise base plugin

Every run that loads plugins also loads a small plugin shipped inside the worker
image, before the others. It carries the **run contract**: Stubwise owns the
checkout, the worktree, the branch, the commit and the pull request, so the
agent must never create them; a question for a human goes through the `ask_user`
tool or nowhere; and a handful of third-party skills are explicitly declared
inapplicable. It also carries the conventions for the plan and for
`STUBWISE_REPORT.md`.

The contract is re-injected when a long run compacts its context, which is
exactly when a skill that says "now commit your work" would otherwise win.

## The recommended preset for superpowers

[superpowers](https://github.com/obra/superpowers) is the plugin this feature
was designed against, and the Project → Plugins page offers **Apply recommended
preset** for it. The preset turns off four skills:

| Skill | Why it's off |
| --- | --- |
| `using-git-worktrees` | Stubwise already created the worktree the agent is standing in. |
| `finishing-a-development-branch` | Stubwise creates the branch, the commit and the pull request. |
| `dispatching-parallel-agents` | Isolation and integration belong to the pipeline; parallel agents in one run would fight over the same checkout. |
| `subagent-driven-development` | Same reason: the unit of work is the job, and the worker serializes jobs per project. |

Everything else — brainstorming, systematic debugging, test-driven development,
writing plans — stays on: that's the part worth having.

The preset is a **recommendation**, not a rule. It only ever turns skills
**off**, never back on, and you can re-enable any of them with a click.

## Security

- **Only admins** can register a plugin or change what runs on a project. A
  plugin is code that runs next to your repositories.
- **Public repos only, over `https://`.** The fetch runs with no credentials at
  all and refuses URLs that carry a username or password, so a plugin can never
  be a private repo pulled with your git credentials. Error messages are
  redacted before they reach the UI.
- **Pinned to a commit.** What was reviewed is what runs. Moving the pin is an
  explicit action, and the UI shows the inventory diff it produces.
- **Hooks are shown with their command.** A hook is code that runs on an event
  without asking; you can read every one of them before enabling the plugin, and
  turn off individual hook groups.
- **Symlinks are refused.** A plugin tree containing one is rejected at
  materialization rather than followed.
- **A plugin's `.mcp.json` is never loaded.** Some plugins ship one to declare
  MCP servers of their own. Stubwise ignores it by construction: the copy of the
  plugin handed to a run omits that file, and the only MCP servers a run can see
  are the ones Stubwise configures itself. The UI tells you when a plugin
  carries one.
- **Plugin files are only on the worker.** They live on a volume the server
  never mounts; the server reads the inventory from the database.

If anything goes wrong — a directory that vanished, a manifest that no longer
matches — the plugin is **skipped for that run only**, with a line in the job
log. A broken plugin never fails a fix.

## Configuration

`PLUGIN_POLL_SECONDS` and `PLUGINS_DIR` in the
[configuration reference](/docs/reference/configuration/#plugin-registry-worker).
Setting `PLUGIN_POLL_SECONDS=0` freezes the registry (nothing is fetched, no
smoke test runs), but plugins that are **already materialized keep running**: to
take a plugin out of the runs, disable it on the projects or remove it from the
registry.
