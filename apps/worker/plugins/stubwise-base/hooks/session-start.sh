#!/bin/sh
# Hook SessionStart del plugin base Stubwise: stampa il "contratto della run"
# come `additionalContext`, così ogni sessione dell'agente parte sapendo cosa
# gestisce la pipeline (checkout, worktree, branch, commit, PR) e quali skill di
# terze parti qui non si applicano. Le stesse regole restano nei prompt del fix:
# cintura e bretelle, perché un plugin può essere disabilitato.
#
# Fail-open per costruzione: qualunque stranezza (node assente, stdin chiuso,
# node che fallisce) esce 0 SENZA stampare nulla. Stampare spazzatura sarebbe
# peggio di un contratto assente, perché il CLI proverebbe a interpretarla.
set -u

# Il CLI passa il payload dell'evento su stdin: va consumato, altrimenti il
# padre può restare in attesa sulla pipe. Il test `-t 0` evita di bloccarsi su
# un terminale quando lo script viene lanciato a mano.
if [ ! -t 0 ]; then
  cat >/dev/null 2>&1 || true
fi

# Nessun node sul PATH: nessun contratto, ma nemmeno un JSON malformato.
command -v node >/dev/null 2>&1 || exit 0

CONTRACT=$(cat <<'STUBWISE_CONTRACT_EOF'
Stubwise run contract. This session runs inside the Stubwise fix pipeline; these rules override any skill or plugin that says otherwise.

Stubwise owns the plumbing: it prepared this checkout and it creates the worktree, the branch, the commit and the pull request.
- Never run git commit, git push, git branch, git checkout -b or git worktree, and never open a pull request. Reading git history is fine.

Planning runs are read-only:
- Do not create, edit or delete any file, and do not write STUBWISE_REPORT.md.
- Your final message is the deliverable: the plan, with its mandatory decisions and assumptions section.

Execution runs:
- Apply the change, add the regression test, run the tests of the affected repository.
- Write STUBWISE_REPORT.md at the root of your working directory: it becomes the body of the pull request.

Asking a human:
- The ask_user tool, when available, is the only channel to a person, and only for a fork in the road that leads to materially different work.
- When it is absent, decide yourself and record the choice. A question in your final message reaches nobody.

Third-party skills, adapted:
- superpowers:brainstorming: keep the method, but every question goes through ask_user.
- superpowers:using-git-worktrees, superpowers:finishing-a-development-branch, superpowers:dispatching-parallel-agents and superpowers:subagent-driven-development do not apply: Stubwise owns isolation and integration, and this run stays a single agent.
STUBWISE_CONTRACT_EOF
)

# L'escaping del JSON lo fa JSON.stringify, non la shell: il contratto è testo
# libero (apostrofi, virgolette, backtick) e costruirlo con `echo` sarebbe una
# bomba a orologeria. Il payload passa in una variabile d'ambiente, non in argv.
OUTPUT=$(
  STUBWISE_CONTRACT="$CONTRACT" node -e 'process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:process.env.STUBWISE_CONTRACT}}))' 2>/dev/null
) || exit 0

printf '%s' "$OUTPUT"
exit 0
