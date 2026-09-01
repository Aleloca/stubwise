---
name: stubwise-conventions
description: Use when writing the plan of a Stubwise planning run or the STUBWISE_REPORT.md of an execution run - which sections each one must have, and where the output has to go.
---

# Stubwise plan and report conventions

## The plan (planning runs)

The plan is your FINAL MESSAGE, never a file: a planning run is read-only, and
anything you write to disk is discarded. Keep it short and concrete - real
files, functions and commands you actually found, not generic advice.

Use these sections, in this order, in the language the prompt asks for:

1. Root cause
2. Files to change
3. Change to apply
4. Regression test
5. Test commands
6. Decisions and assumptions - MANDATORY: every non-obvious choice you made on
   your own, and every assumption the implementer would otherwise have to
   re-take. Write "none" only if there is genuinely nothing.

If `superpowers:writing-plans` is available, use it for the structure and the
rigour of the plan, but the output stays this final message: do not create a
plan file, and drop any worktree, branch or merge step - Stubwise owns those.

## The report (execution runs)

Write `STUBWISE_REPORT.md` at the root of your working directory, in the
language the prompt asks for, with exactly these sections: Investigation, Root
cause, Solution, Rationale.

It becomes the body of the pull request, so write it for a reviewer who has not
seen your session: what you looked at, why the bug happened, what you changed
and why that change and not another. Stubwise keeps the file out of the commit
and opens the pull request itself.
