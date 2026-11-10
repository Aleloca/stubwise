# Integrazione area 3, fetta 3b «Agire» — parità col prototipo (10 nov 2026)

Le azioni di Claude nella **build app**, sulle rotte del server. Piano:
`docs/plans/2026-11-10-integrazione-area3bcde-plan.md` (3b.2); la lettura è
della 3a (`integration-area3a.md`). Accese in `data/integration.ts`:
`claude-actions` e `claude-decisions`. Restano spente la chat libera
(`claude-chat`), gli allegati nelle sessioni (`claude-attachments`) e le
domande della doc di prodotto in «Da decidere» (`product-docs`).

Regola di fondo: **ogni permesso lo dice il server**, mai dedotto. Cosa si
può fare dopo un'azione si rilegge (`/work`, il dettaglio della sessione):
le scritture invalidano le loro aree.

| Voce | Dove vive (renderer) | Rotta | Test |
|---|---|---|---|
| Avvia | `pages/task/ClaudeSection.tsx`; `real/claudeActions.ts` (`startRun`) | `POST /api/tickets/:id/run-ai` | `real/claudeActions.test.ts` |
| Rilancia con indicazioni: le indicazioni diventano un commento del team, poi il job riparte sul fix | `ClaudeSection.tsx` (campo in linea); `relaunchWithInstructions` | `POST /api/tickets/:id/comments`, poi `run-ai` con `withInstructions` | `real/claudeActions.test.ts`, `real/taskPanel.test.tsx` |
| Riprendi la correzione ferma: quale lo dice il ticket (`cycle.heldJobId`) | `resumeCorrection` | `GET /api/tickets/:id`, `run-ai` con `resumeCorrectionJobId` (409 `correction_not_held`) | `real/claudeActions.test.ts` |
| Chiedi modifiche: sulla PR aperta che il server dice correggibile | `requestChanges` | `POST /api/tickets/:id/repositories/:repo/corrections` | `real/claudeActions.test.ts` |
| «Annulla il lavoro», con conferma: chiude il lavoro parcheggiato; su `run_in_progress` propone «Ferma» | `ClaudeSection.tsx` (`CancelRunDialog`, nel menu «⋯» per chi ha `runs.start`); `cancelRun` (anche nel prototipo, che non l'aveva) | `POST /api/tasks/:id/cancel-run` (409 `run_in_progress`, `nothing_to_cancel`) | `real/claudeActions.test.ts`, `real/taskPanel.test.tsx` |
| Piano: approva, rifiuta con indicazioni, pre-approva, revoca — nelle sessioni, nella sezione e in «Da decidere» | `PlanCard.tsx`, `ClaudeDecisionItem.tsx`; `decidePlan`, `preApprovePlan`, `revokePlanApproval` | `POST /api/tickets/:id/{approve-plan,reject-plan}`, `POST`/`DELETE …/pre-approve-plan` (409 `no_plan`) | `real/claudeActions.test.ts`, `real/claude.test.ts`, `real/homePage.test.tsx` |
| Domande (`ask_user`): rispondere dalla sessione, dalla sezione e da «Da decidere» | `QuestionCard.tsx`; `answerQuestion` | `POST /api/tickets/:id/questions/answer` (409 `question_not_pending`) | `real/claudeActions.test.ts` |
| Scrivere nella sessione, «Ferma», «Ferma e scrivi» (anche nella sessione seguita nel pannello della task) | `Conversation.tsx`, `Composer.tsx`; `sendMessage`, `stop`, `stopAndSend` | `POST /api/agent-sessions/:id/messages` (`interrupt`) | `real/claudeActions.test.ts`, `real/claudeSessionPage.test.tsx` |
| «Da decidere» di Claude: piani (a chi ha `plans.approve`) e domande (a chi può rispondere) | `pages/home/blocks/DecideBlock.tsx`; `listClaudeDecisions` | `GET /api/me/claude-decisions` (404 su un server più vecchio: nessuna voce) | `real/claudeActions.test.ts`, `real/homePage.test.tsx`, `pages/ComingSoon.test.tsx` |

## Permessi del dettaglio di una sessione

| Permesso | Da dove |
|---|---|
| Scrivere, fermare | `canWrite`, `canInterrupt` del dettaglio |
| Rispondere | `canAnswer` della domanda aperta |
| Decidere il piano (approva/rifiuta) | sessione in `awaiting_approval` **e** `waitsOnViewer` (il piano aspetta chi guarda) |
| Pre-approvare, revocare | `plans.approve` nel progetto (da `/api/auth/me`, calcolato dal server), sul piano SALVATO del ticket (`implementationPlan`; la pre-approvazione vale se non `planApprovalStale`) |
| Perché non si scrive | conclusa → `finished`; non di lavoro → `automatic`; segmento non interattivo → `not_interactive`; altrimenti `no_permission` («Only a maintainer…») |

## Scelte e limiti

| Scelta o limite | Chi ha deciso |
|---|---|
| «Annulla il lavoro» vale solo per il lavoro parcheggiato (in coda, fermo, in attesa del piano o di una risposta); su uno in esecuzione il server risponde `run_in_progress` e il dialogo propone «Ferma». L'annullamento in corsa arriva con il 3b.1-bis | maintainer / orchestratrice |
| I rifiuti del server hanno una frase per codice (`taskDetail.claude.errors.*`: `job_in_flight`, `needs_maintainer`, `correction_not_held`, `adopted_branch_protected`, `review_ticket_not_runnable`, `no_plan`, `question_not_pending`, `forbidden`, `not_found`, `pr_not_open`); un codice ignoto dice l'errore generico | costruttore |
| Pre-approvare chiede un piano salvato: il prototipo la permetteva mentre il piano si scriveva, il server no (409 `no_plan`) | design |
| Niente allegati nei messaggi a una sessione: il server non li accetta, la graffetta non c'è | costruttore |
| La decisione su un piano da «Da decidere» non verifica che il piano sia ancora quello letto (`planId`): il server approva il piano in attesa del ticket | server |
| Il piano «annullato o mai deciso» avrà un valore suo dal server (in arrivo): oggi un valore ignoto non mostra la scheda | orchestratrice (in arrivo) |
