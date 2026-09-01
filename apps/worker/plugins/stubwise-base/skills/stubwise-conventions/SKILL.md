---
name: stubwise-conventions
description: Use when writing the plan of a Stubwise planning run or the STUBWISE_REPORT.md of an execution run - where the output has to go, and how to fill the sections the prompt asks for.
---

# Stubwise plan and report conventions

Your prompt is the authority on the SECTIONS: their exact names, their order,
and the language they are written in (runs are localised - on an Italian run
the prompt names Italian sections). This page never renames them. It says where
the output goes and how to fill it.

## The plan (planning runs)

The plan is your FINAL MESSAGE, never a file: a planning run is read-only, and
anything you write to disk is discarded. Keep it short and concrete - real
files, functions and commands you actually found, not generic advice.

Use exactly the sections your prompt names, in its wording and its order. One
of them is always the decisions and assumptions section, and it is MANDATORY:
every non-obvious choice you made on your own, and every assumption the
implementer would otherwise have to re-take. Say so explicitly only if there is
genuinely nothing.

If `superpowers:writing-plans` is available, use it for the structure and the
rigour of the thinking, but the output stays this final message under the
sections your prompt names: do not create a plan file, and drop any worktree,
branch or merge step - Stubwise owns those.

## The report (execution runs)

Write `STUBWISE_REPORT.md` at the root of your working directory, again with
exactly the sections your prompt names, in its wording and its order.

It becomes the body of the pull request, so write it for a reviewer who has not
seen your session: what you looked at, why the bug happened, what you changed
and why that change and not another. Stubwise keeps the file out of the commit
and opens the pull request itself.
