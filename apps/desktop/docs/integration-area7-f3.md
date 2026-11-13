# Integrazione area 7 «Automations», fetta 3: i passi di Claude — parità col prototipo (BOZZA, 13 nov 2026)

Cosa delle Automations del prototipo arriva sul server vero nella fetta 3.
Piano: `docs/plans/2026-11-13-integrazione-area7-fetta3-plan.md` (su
`docs/area7-f3-plan`), con le risposte F3-1…F3-5 e il confine di F3-1
*(O, 46)*. Server, worker, `@stubwise/api-client` e il golden sono di
stubwise-72 (`feat/area7-f3`); qui il renderer e i pezzi del motore
condiviso che il piano gli assegna (`feat/area7-f3-renderer`).

⚠️ **Bozza.** Nella build app la disponibilità della F3 si accende con la
funzione `automations-f3`, SPENTA finché il maintainer non dice di
accenderla: fino ad allora un passo di Claude è «Coming soon» nel
costruttore e `not_available` nella validazione.

## Renderer e motore condiviso (stubwise-94)

| Voce del prototipo | Build app | Test | Stato |
|---|---|---|---|
| Il passo di Claude nel costruttore (R1) | `AUTOMATION_F3_AVAILABILITY` in `@stubwise/shared` (la F2 più `claude`); nella build app con `automations-f3` | `shared/automations/availability.test.ts`, `data/integration.test.ts` | fatto, spento |
| Una risposta di Claude fuori forma | `checkClaudeResult` del motore condiviso (dalla F1): un'uscita fuori elenco, un campo in più, mancante o del tipo sbagliato è un errore del passo, mai un ramo; vale nella prova e nell'esecuzione | `shared/automations/claudeStep.test.ts` | fatto |
| I campi tinti e la destinazione (F3-1 = a, confine O di 46) | `automations/taint.ts`: tinti i campi di un'email arrivata, la risposta di un cliente, l'evento di una sorgente, e ciò che Claude ne ricava (anche gli elementi di un «per ogni» su un suo elenco). Un passo che sceglie a chi o dove con un campo DECISO DA CLAUDE e tinto chiede sempre l'approvazione: `untrusted_target` in `validateFlow`, che il server applica uguale. Un campo grezzo dell'evento come destinazione resta permesso (F2) | `shared/automations/taint.test.ts` | fatto |
| Il costruttore che forza «chiede a» (F3-1) | ogni modifica passa da `forceApprovalForUntrusted`; nel pannello «Runs by itself» non si sceglie, col motivo; la riga dice il problema | `builder/BuilderTaint.test.tsx` | fatto |
| La prova con Claude vero (D4, F3-3 = a) | i passi di Claude della prova passano dal server (`testEstimate`, `testClaude`); al primo la prova si ferma col costo stimato (`costToConfirm`; `null` = non stimabile), confermato UNA volta va avanti da sola. Una risposta fuori forma (422) la fallisce il motore coi suoi codici; il budget finito, una risposta non JSON e un server senza la F3 fermano la prova con parole loro. Gli input tagliati si dicono in testa alla motivazione con `truncationNote` di shared, la stessa dell'esecutore. Il client non chiama mai il modello | `real/automationSimulate.test.ts`, `real/automationsLive.test.ts`, `real/automationsF3Page.test.tsx`, `test/CostConfirm.test.tsx` | fatto, spento |
| Le esecuzioni con Claude (R4) | ferma per il budget mensile (`aiWaiting`): lo dice e non offre «Retry»; una motivazione che cita un'email che chi guarda non vede (`reasonHidden`) lo dice in parole | `real/automationsF3Page.test.tsx` | fatto |
| Usage e Impostazioni → AI (R6) | l'etichetta di `automation_step` («Automation steps» / «Passi delle automazioni»), gruppo automations | `data/instance/ai.test.ts` (S1 di 72) | fatto |
| La prova di Claude nel prototipo | Claude finto, gratuito: niente costo da confermare (`confirmSimulationCost` non fa niente) | — | come prima |

### Differenze dichiarate

- La pausa d'istanza della coda AI (`queue_paused`) non arriva dal server
  nella F3 (C-F3-3): le pagine la sanno dire, ma oggi non capita.
