# Integrazione area 7 «Automations», fetta 1: il motore e le automazioni di progetto — parità col prototipo (BOZZA, 13 nov 2026)

Cosa delle Automations del prototipo (`data/automations/*`,
`pages/automations/*`, i blocchi della Home) arriva sul server vero nella
fetta 1. Piano: `docs/plans/2026-11-12-integrazione-area7-fetta1-plan.md`
(su `feat/area7-f1`), con le risposte P1–P5 = a *(O, 46)* e le «Correzioni di
72». Server, worker, `@stubwise/api-client` e il motore nel worker sono di
stubwise-72 (`feat/area7-f1`); qui il renderer (`feat/area7-f1-engine`).

⚠️ **Bozza.** La destinazione `automations` resta SPENTA nella build app
finché il server dell'area 7 non c'è. Gli adattatori (livello dati, prova,
«Da decidere») sono cablati su `client.automations`
(`data/backend/real/automationsLive.ts`), su tutte le rotte della F1.

## Renderer (stubwise-94)

| Voce del prototipo | Build app | Test | Stato |
|---|---|---|---|
| Il motore (condizioni, giri, approvazioni, validazione) | lo stesso modulo in `@stubwise/shared` (`automations/`), che server e worker usano uguale; `not_available` per ciò che è fuori dalla F1, `chainAllows`/`CHAIN_MAX` | `packages/shared` (isolamento del motore) | fatto |
| Il costruttore: passi e inizi | solo quelli della F1; gli altri «Coming soon», non selezionabili; un flusso che li contiene ha `not_available` (R5) | `pages/automations/builder/BuilderF1.test.tsx` | fatto |
| L'inizio «richiesta convertita» (Q5) | anche nel prototipo; la conversione segnala anche «task creata» (R6) | `data/automations/*` | fatto |
| La prova senza effetti (P1 = a) | nel CLIENT, sullo stesso nucleo puro del prototipo (`domain/automations/simCore.ts`). Il mondo viene dal contesto di `GET …/examples` (`SimulationContext`: persone, chi ha un ruolo, membri dei reparti, `seenBy`, `ownerCan`, errori di configurazione, il proprietario). Il client non deduce né chi approva né chi può fare cosa. Non scrive niente: oltre agli esempi chiama solo `POST …/tested` con la rev, a prova finita bene | `domain/automations/simCore.test.ts`, `data/backend/real/automationSimulate.test.ts`, `automationsLive.test.ts` | cablato. Un 409 `stale` su `/tested` (la bozza è cambiata mentre si provava) non rompe la prova: quella rev resta non provata |
| «Da decidere» e il blocco «Automations» della Home (R7) | `listMyRuns`, `listMyApprovals`, `getRun`, Approva/Rifiuta per id, sopra `/api/me/automation-*` e `…/runs/:n/{approve,reject}` con `expectedPath` + `expectedRound` (il giro visto). Il 409 `stale` (anche su un'esecuzione finita) diventa `invalid: not_waiting` e la pagina dice «già deciso da …» | `data/backend/real/automationDecisions.test.ts`, `automationsLive.test.ts` | cablato (`/api/me/automation-runs`, `/api/me/automation-approvals`) |
| Le automazioni generali e la loro voce in colonna | non ci sono (F4) | `pages/automations/AutomationsF1.test.tsx` | fatto |
| Sources, webhook, tabella cliente → progetto | non ci sono (F4); le funzioni restano stub | `AutomationsF1.test.tsx`, `ComingSoon.test.tsx` | fatto |
| «New automation» coi due modelli | solo da zero (P2 = a): niente modelli nel dialogo, nel menu e nel vuoto | `AutomationsF1.test.tsx` | fatto |
| «Pass time» e «Simulate reply» nell'esecuzione | solo nel prototipo | `AutomationsF1.test.tsx` | fatto |
| Il livello dati: elenco, dettaglio, check della bozza, creazione da zero, salvataggio con `expectedRev`, rinomina, pubblica/accendi/pausa/duplica/elimina col rev letto, esecuzioni, Run now, annulla/riprova/salta, scegli il progetto, sezione del progetto, riga d'origine (R2) | `data/backend/real/automations.ts`, per codice dalle letture (`automationRefs.ts`). Il 409 `stale` sulla bozza è `invalid: stale`: il costruttore offre «Reload» e la modifica resta a schermo. Un 409 `config` è `invalid: config`: gli errori la pagina li legge dal dettaglio, come nel prototipo. I codici e le revisioni letti si dimenticano al cambio di persona | `real/automations.test.ts`, `real/automationsLive.test.ts`, `builder/Builder.test.tsx` | cablato. La riga d'origine di una task si chiede solo se il server dice che l'ha creata un'automazione (`source`) e la destinazione è accesa: allora un 404 è «non la vedi» (`visible: false`). Per i traguardi aspetta il segno dal server |
| ⌘K: automazioni ed esecuzioni | il gruppo `automations` di `GET /api/search` (filtrato dal server); a destinazione spenta non si cerca, e un server senza il gruppo non dà risultati | `real/automationsGated.test.ts` | fatto |
| Le pagine fino alla richiesta esatta (R4) | sopra `client.automations`, a flag acceso | `automationsPage.test.tsx` (da scrivere) | da fare |
| Le forme | le letture in `@stubwise/shared` (`automations/views.ts`), forme confermate da 72; `round?` facoltativo su `AutomationDecision`/`AutomationRunRow` (assente = 0) | — | fatto |

### Differenze dichiarate

- La prova della F1 gira nel client e non costa: dalla F3, coi passi di
  Claude, passa dal server (D4).
- Le prove stanno in memoria nel renderer. Se si ricarica la pagina, la
  prova si perde. È la stessa cosa del prototipo.

## Commit (`feat/area7-f1-engine`)

3b077823, 968acbe0 (task 0) · ee84e161 (R6) · 7d9fe134 (R5) · ee9047d7
(le forme) · a5864b67, 86d0c883, bf5fc869, ec1d3095 (R3) · 457e63ec,
5b1fbf40 (R7) · 9f7acbdf (R4, prima parte) · 1954b346 (R2) · il cablaggio
su `client.automations`.
