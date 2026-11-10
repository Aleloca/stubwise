# Integrazione area 3, fetta 3e «Claude assegnabile» — parità col prototipo (10 nov 2026)

Claude come collega assegnabile nella **build app** (renderer, 3e.2), sopra il
server della 3e.1: Claude è un utente di sistema (`users.is_agent`), compare
in `/api/people` con `isClaude` e, per chi guarda, con i progetti in cui può
assegnarlo (`claudeAssignableProjectIds`: quelli dove ha `runs.start`).
Assegnargli una task avvia il lavoro (lo fa il server). Funzione
`claude-assign` accesa nella build app.

| Voce | Dove vive (renderer) | Rotta | Test |
|---|---|---|---|
| Claude dalla riga di `/api/people`: `isClaude` e, solo per lui, `assignableProjectIds` | `real/people.ts` (`toPerson`), `data/model.ts` | `GET /api/people` | `real/claudeAssign.test.tsx` |
| Chi si assegna in un progetto: i membri, più Claude dove la sua riga lo dice. Una regola sola (`isAssignableIn`/`assignableIn`) per assegnatario della task, blocco, filtro dell'assegnatario, righe e menu «Plan» del Planning e il controllo di `planBlock` (`rights.members`) | `data/assignable.ts`; `pages/tasks/pickers.tsx`, `pages/planning/PlanningPage.tsx`, `tasks-ui/FilterBar.tsx` | — | `real/claudeAssign.test.tsx` (riga, voce del menu, assente senza `runs.start`) |
| La riga di Claude nel Planning di progetto con il suo carico, per ultima; nei candidati del menu «Plan», per ultimo | `PlanningPage.tsx` (`rowPeople`, `candidates`) | `POST /api/tasks/:id/plan` | `real/claudeAssign.test.tsx` |
| Claude sulle carte: l'anello tratteggiato e il nome «Claude» dovunque una task gli è assegnata, anche a chi non può assegnarlo | `tasks-ui/PersonChip.tsx` (invariato: basta `isClaude` vero) | `GET /api/tasks` | `real/claudeAssign.test.tsx` («Claude sulle carte») |
| Un 403 `claude_assign_forbidden` ha la sua frase: nel Planning (rifiuto, niente «Try again»), sulla task, in blocco | `pages/planning/planRefusal.ts`, `pickers.tsx` (`useInlineUpdate`), `pages/tasks/BulkBar.tsx`; `planning.refused.claude_assign_forbidden`, `tasks.bulk.claudeForbidden_*` | `POST /api/tasks/:id/plan`, `PATCH /api/tasks/:id`, `PATCH /api/tasks/bulk` | `real/claudeAssign.test.tsx` |
| Il polso: «Claude al lavoro» (una sessione di lavoro su una task, `ai_job`, al lavoro o in coda, nel progetto) e «Claude aspetta te» (le voci di Claude in «Da decidere») | `real/claudePulse.ts`, `real/overview.ts` (`pulsesOf`) | `GET /api/agent-sessions`, `GET /api/me/claude-decisions` | `real/claudePulse.test.ts` |
| Le tessere del binario: «Claude al lavoro» (`signals.claudeWorking`) e il punto «ti aspetta» anche per Claude | `real/projects.ts` (`listProjects`, `getProjectByCode`, `listWaitingOnMeProjectIds`) | come sopra | `real/claudePulse.test.ts` |

## Scelte e limiti

| Scelta o limite | Chi ha deciso |
|---|---|
| Claude si assegna solo dove il server lo dice (`claudeAssignableProjectIds`), mai dedotto dai permessi sul client | maintainer |
| La riga di Claude nel Planning di progetto c'è solo dove chi guarda può assegnarlo: chi non ha `runs.start` vede le task di Claude nelle liste (con l'anello), non la sua riga nel Planning. Nel Planning trasversale la riga c'è sempre, come nel prototipo | costruttore |
| «Claude al lavoro» conta le sole sessioni `ai_job`: le sessioni di sfondo (Docs, brief, report, posta) girano ogni notte su tutti i progetti e il segnale non direbbe più niente | costruttore |
| Le letture di Claude del polso sono fail-open: un errore o un server senza le rotte lascia il polso senza Claude, non un errore | costruttore |
| Nel prototipo Claude è un membro (`memberIds`) e `assignableProjectIds` è assente: il comportamento non cambia | — |
