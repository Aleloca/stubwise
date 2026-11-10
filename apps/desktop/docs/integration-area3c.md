# Integrazione area 3, fetta 3c «Refinement» — parità col prototipo (10 nov 2026)

Il refinement delle richieste con Claude nella **build app**, sulla sessione
`backlog_refine` del server. Piano: `docs/plans/2026-11-10-integrazione-area3bcde-plan.md`
(3c.2). Lato server non è servito niente di nuovo (3c.1): le rotte c'erano.
Accesa in `data/integration.ts` la funzione `refine`.

| Voce | Dove vive (renderer) | Rotta | Test |
|---|---|---|---|
| «Refine with Claude» acceso nel dettaglio della richiesta; apre (o ritrova) la sessione | `pages/requests/RequestDetail.tsx`; `real/claudeRefine.ts` (`startRefineConversation`) | `POST /api/backlog/:id/refine-session` (l'id della voce è quello della richiesta) | `real/claudeRefine.test.ts`, `real/requestsPage.test.tsx` |
| La sessione della richiesta: quella aperta, se no la più recente chiusa | `getRefineOf` | `GET /api/agent-sessions?kind=backlog_refine` (filtrata per `backlogItemId`) | `real/claudeRefine.test.ts`, `pages/ComingSoon.test.tsx` |
| La vista del refinement (`?refine=1`) con la sessione dal vivo, casella e «Ferma» | `pages/requests/RefineView.tsx` | `GET /api/agent-sessions/:id`, eventi, stream, messaggi (come ogni sessione) | `real/requestsPage.test.tsx` |
| Le scritture di Claude (design, piano, metadati) come esiti con la patch della richiesta; «See» apre il lato | `real/claude.ts` (`withRefineResults`) | i tool `mcp__stubwise_refine__{set_design,set_plan,update_item}` negli eventi | `real/claudeRefine.test.ts`, `real/requestsPage.test.tsx` |
| «Close session»; «Start new» su una sessione chiusa | `RefineView.tsx`; `closeRefine`, `startRefineConversation` | `DELETE /api/backlog/:id/refine-session` | `real/claudeRefine.test.ts` |

## Scelte e limiti

| Scelta o limite | Chi ha deciso |
|---|---|
| Chi scrive e chiude lo dice il server (`canWrite`, `canClose`: `backlog.edit`); «Start new» c'è su una sessione chiusa per chi ha `backlog.edit` (dai permessi calcolati dal server) se la richiesta si può ancora rifinire (nuova, in rifinitura o pronta, non fusa) | server / costruttore |
| Una scrittura riuscita si legge come il suo esito (`design_updated`, `plan_updated`, `estimate_updated`) al posto dell'azione, col testo del risultato del server; in corso o fallita resta l'azione. Sforzo E1–E5 → taglia XS–XL, «urgent» → High | costruttore |
| Il piano scritto nel refinement NON è approvato (`docs/invariants/backlog-refine.md`): si legge come piano della richiesta | server |
