#!/bin/sh
# Hook SessionStart del plugin base Stubwise: stampa il "contratto della run"
# come `additionalContext`, così ogni sessione dell'agente parte sapendo cosa
# gestisce la pipeline (checkout, worktree, branch, commit, PR) e quali skill di
# terze parti qui non si applicano. Le regole su git restano anche nei prompt
# del fix: cintura e bretelle, perché un plugin può essere disabilitato.
#
# Il contratto NON impone la forma del deliverable: lo stesso hook entra anche
# nei run di backlog (deep dive, chat di raffinamento), dove il deliverable è
# l'analisi o la risposta e lo decide il prompt. Restano sempre valide solo le
# regole su git e su `ask_user`.
#
# Fail-open per costruzione: qualunque stranezza (node assente, node che
# fallisce, stdin chiuso) esce 0 SENZA stampare nulla. Per SessionStart uno
# stdout non-JSON non rompe il CLI — lo aggiunge al contesto come testo — ma
# sarebbe rumore pagato a ogni run: meglio nessun contratto che spazzatura.
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
Stubwise run contract for this session. The git and ask_user rules below always apply, over any skill or plugin that says otherwise; your prompt decides the deliverable.

Stubwise owns the plumbing: it prepared this checkout and it creates the worktree, branch, commit and pull request.
- Never run git commit, git push, git branch, git checkout -b or git worktree, and never open a pull request. Reading git history is fine.

Read-only runs (planning, analysis):
- Do not create, edit or delete any file, and do not write STUBWISE_REPORT.md.
- Your final message is the deliverable, with the sections your prompt names: a plan keeps its mandatory decisions and assumptions section.

Execution runs:
- Apply the change, add the regression test, run the tests of the affected repository.
- Write STUBWISE_REPORT.md at the root of your working directory: it becomes the body of the pull request.

Asking a human:
- The ask_user tool, when available, is the only channel to a person, and only for a fork that leads to materially different work.
- When absent, decide yourself and record the choice. A question in your final message reaches nobody.

Third-party skills, adapted:
- superpowers:brainstorming: keep the method, but every question goes through ask_user.
- superpowers:using-git-worktrees, superpowers:finishing-a-development-branch, superpowers:dispatching-parallel-agents and superpowers:subagent-driven-development do not apply: Stubwise owns isolation and integration.
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
