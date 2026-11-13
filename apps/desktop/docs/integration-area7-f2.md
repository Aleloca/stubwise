# Integrazione area 7 «Automations», fetta 2: email e attese — parità col prototipo (13 nov 2026)

Cosa delle Automations del prototipo arriva sul server vero nella fetta 2.
Piano: `docs/plans/2026-11-13-integrazione-area7-fetta2-plan.md` (su
`feat/area7-f2`), con le risposte F2-1…F2-6 e le «Correzioni di 72»
(C-F2-0…C-F2-5). Server, worker, `@stubwise/api-client` sono di stubwise-72
(`feat/area7-f2`); qui il renderer e i pezzi del motore condiviso che il
piano gli assegna (`feat/area7-f2-renderer`).

Nella build app la disponibilità della F2 è ACCESA (funzione
`automations-f2`, via di 46 del 13 nov 2026, con la F2 del server chiusa:
7d2e32d6).

## Renderer e motore condiviso (stubwise-94)

| Voce del prototipo | Build app | Test | Stato |
|---|---|---|---|
| I passi e gli inizi della F2 (R1) | `AUTOMATION_F2_AVAILABILITY` in `@stubwise/shared`: email, attese, «ripeti finché», inizi a orario ed «email in arrivo»; Claude (F3), «avvia un'altra» e le sorgenti (F4) restano «Coming soon». Un'email con allegati è `not_available` (F2-5 = a, `emailAttachments: false`). Nella build app con `automations-f2` | `shared/automations/availability.test.ts`, `builder/BuilderPerimeter.test.tsx`, `data/integration.test.ts` | fatto |
| Il piano di «Manda email» (R2) | `planEmail` e `sameConversation` in `@stubwise/shared` (`automations/email.ts`): il tetto della catena, la casella del proprietario dal mondo (`ownerMailbox`, con `mailbox_scope` in più) e l'indirizzo, coi codici e le parole del prototipo. Il prototipo delega i controlli e tiene la bozza della Posta e il rimbalzo finto; il worker usa gli stessi | `shared/automations/email.test.ts`, i test del prototipo invariati | fatto |
| Accendere e pubblicare con la casella (R3) | il dialogo del prototipo sceglie per indirizzo fra le mie caselle (`GET /api/me/google/accounts`); l'adattatore manda `mailboxAccountId`. `mailbox_required` del server e una casella non più mia sono `mailbox_missing` del prototipo (le sue parole); `mailbox_scope` ha parole sue. «Email in arrivo» chiede la casella anche senza email da mandare: è quella che ascolta (la scelta di 72) | `real/automationsF2Page.test.tsx`, `real/automations.test.ts` | fatto |
| Le esecuzioni con email e attese (R4) | le righe le scrive il motore condiviso, come nel prototipo: l'email partita (`effects` col messaggio Gmail), l'attesa (`waitingUntil`), la risposta che chi non è il proprietario non legge (`replyHidden`, `hideReplies` di shared, la regola del prototipo, che il server applica), l'email non mandata (`emailFailed` col codice del mittente in parole). Approvare un'email con «Edit» manda `edited` coi soli campi cambiati | `real/automationsF2Page.test.tsx` | fatto |
| La prova con email e attese (R5) | nel client, come la F1: gli agganci fuori dalla F1 del nucleo della prova sono facoltativi uno per uno (la build app ha solo l'email); l'email della prova usa `planEmail` e la casella che il server risolve (`SimulationContext.ownerMailbox`); non manda niente. L'attesa della risposta si ferma e la risposta scritta la sveglia | `real/automationSimulate.test.ts` | fatto |
| La ricorrenza mensile (R6) | `scheduleDue` e `localDate` in `@stubwise/shared` (`automations/schedule.ts`): giornaliera, settimanale, MENSILE (un giorno che il mese non ha cade all'ultimo), nel fuso dato (worker: Europe/Rome; prototipo: UTC). Anche il prototipo ora fa scattare la mensile (il buco dell'inventario §2.6) | `shared/automations/schedule.test.ts` (cambio dell'ora, fuso negativo, processo su un fuso negativo), `data/automations/automations.test.ts` | fatto |
| La pausa automatica col suo motivo | accanto allo stato, dal server (`pausedReason`: la casella del proprietario non più utilizzabile, un permesso perso); una pausa a mano resta «paused by …» | `real/automationsF2Page.test.tsx` | fatto |
| «Pass time» e «Simulate reply» nell'esecuzione | solo nel prototipo | — | come la F1 |

### Differenze dichiarate

- Nel dialogo d'accensione una casella a cui manca lo scope d'invio si
  offre lo stesso: la rifiuta il server (409 `mailbox_scope`, detto in
  parole). `missingScopes` non si mostra.
