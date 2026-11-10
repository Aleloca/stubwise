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
| La riga di Claude nel Planning di progetto con il suo carico, per ultima, per chiunque veda il Planning; nei candidati del menu «Plan», per ultimo, solo dove si assegna. Dove chi guarda non può assegnarlo la riga è in sola lettura come le righe altrui, col motivo al passaggio («Only someone who can start Claude's work plans for Claude»), e non è un bersaglio (`planBlock` con `assignableIn`: `member`) | `PlanningPage.tsx` (`rowPeople`, `readOnly`, `candidates`, `rightsOf`); `planning.claudeReadOnly` | `POST /api/tasks/:id/plan` | `real/claudeAssign.test.tsx`, `data/assignable.test.ts` |
| Claude sulle carte: l'anello tratteggiato e il nome «Claude» dovunque una task gli è assegnata, anche a chi non può assegnarlo | `tasks-ui/PersonChip.tsx` (invariato: basta `isClaude` vero) | `GET /api/tasks` | `real/claudeAssign.test.tsx` («Claude sulle carte») |
| Un 403 `claude_assign_forbidden` ha la sua frase: nel Planning (rifiuto, niente «Try again»), sulla task, in blocco | `pages/planning/planRefusal.ts`, `pickers.tsx` (`useInlineUpdate`), `pages/tasks/BulkBar.tsx`; `planning.refused.claude_assign_forbidden`, `tasks.bulk.claudeForbidden_*` | `POST /api/tasks/:id/plan`, `PATCH /api/tasks/:id`, `PATCH /api/tasks/bulk` | `real/claudeAssign.test.tsx` |
| Assegnato a Claude ma il lavoro non parte: la scrittura risponde `claudeRun: "refused:<codice>"` (review dell'area 3, punto 5) e compare la frase del codice (`job_in_flight`: ci sta già lavorando; un codice ignoto: la frase generica) — sulla task, in blocco, dal Planning, alla creazione | `tasks-ui/claudeRun.ts`; `pickers.tsx`, `BulkBar.tsx`, `PlanningPage.tsx`, `NewTaskDialog.tsx`; `real/tasks.ts` (`toTask`), `Task.claudeRun` | `PATCH /api/tasks/:id`, `PATCH /api/tasks/bulk`, `POST /api/tasks/:id/plan`, `POST /api/tasks` | `real/claudeAssign.test.tsx` |
| Il polso: «Claude al lavoro» (una sessione di lavoro su una task, `ai_job`, al lavoro o in coda, nel progetto) e «Claude aspetta te» (le voci di Claude in «Da decidere») | `real/claudePulse.ts`, `real/overview.ts` (`pulsesOf`) | `GET /api/agent-sessions`, `GET /api/me/claude-decisions` | `real/claudePulse.test.ts` |
| Le tessere del binario: «Claude al lavoro» (`signals.claudeWorking`) e il punto «ti aspetta» anche per Claude | `real/projects.ts` (`listProjects`, `getProjectByCode`, `listWaitingOnMeProjectIds`) | come sopra | `real/claudePulse.test.ts` |

## «Link a person» nello standup

Il gesto della scheda «By person» di Activity (3d) per gli autori di commit non
collegati, sopra il server che attribuisce i commit anche via
`git_identities`. Funzione `commit-author-link` accesa nella build app.

| Voce | Dove vive (renderer) | Rotta | Test |
|---|---|---|---|
| La riga senza persona mostra l'email dell'autore (se non è già il nome) e lo username GitHub di una noreply | `pages/projects/PeopleActivity.tsx` (`authorLine`); `real/peopleActivity.ts`; `PersonDayActivity.authorEmail/authorUsername` | `GET /api/people/activity` | `real/peopleActivityPage.test.tsx` |
| Sul web, con `users.manage`: «Link a person» → la persona → l'email dell'autore diventa una sua identità git; con la riconferma (`useReauth`: il dialogo si apre, col codice l'azione riparte da sola) | `PeopleActivity.tsx` (`doLink`); `real/peopleActivity.ts` (`linkCommitAuthor`) | `POST /api/users/:id/git-identities` (`users.manage`, `config.reauth`) | `real/peopleActivityPage.test.tsx` |
| Un'email già collegata a qualcuno (409 `git_identity_taken`): la sua frase | `PeopleActivity.tsx`; `projects.people.linkTaken` | come sopra | `real/peopleActivityPage.test.tsx` |
| Sul desktop il gesto apre la stessa pagina sul web (`/app/#…`, `openInWeb`), dove si fa con la riconferma; dal desktop non si scrive | `PeopleActivity.tsx`; `platform/openWeb.ts` | — | `real/peopleActivityPage.test.tsx` |
| Senza `users.manage`, o su una riga senza email (un server più vecchio): niente gesto | `PeopleActivity.tsx` (`linkable`) | — | `real/peopleActivityPage.test.tsx` |

## Scelte e limiti

| Scelta o limite | Chi ha deciso |
|---|---|
| Claude si assegna solo dove il server lo dice (`claudeAssignableProjectIds`), mai dedotto dai permessi sul client | maintainer |
| La riga di Claude nel Planning di progetto la vede chiunque veda il Planning, con il suo carico; per chi non ha `runs.start` è in sola lettura (non un bersaglio, motivo al passaggio). Nel trasversale lo decide `planBlock` task per task | orchestratrice (si segue il prototipo) |
| «Claude al lavoro» conta le sole sessioni `ai_job`: le sessioni di sfondo (Docs, brief, report, posta) girano ogni notte su tutti i progetti e il segnale non direbbe più niente | costruttore |
| Le letture di Claude del polso sono fail-open: un errore o un server senza le rotte lascia il polso senza Claude, non un errore | costruttore |
| Nel prototipo Claude è un membro (`memberIds`) e `assignableProjectIds` è assente: il comportamento non cambia | — |
| «Link a person» collega l'EMAIL dell'autore (le righe senza persona sono per email); lo username GitHub si mostra ma non abbina (nessuna tabella lega un utente al suo login) | server |
| Dal desktop la riconferma non si fa nell'app: il gesto apre il web sulla stessa pagina | orchestratrice |
