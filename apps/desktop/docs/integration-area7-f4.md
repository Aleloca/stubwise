# Integrazione area 7 «Automations», fetta 4: le generali, il webhook in arrivo e «avvia un'altra» — parità col prototipo (13 nov 2026)

Cosa delle Automations del prototipo arriva sul server vero nella fetta 4.
Piano: `docs/plans/2026-11-13-integrazione-area7-fetta4-plan.md` (la copia
autorevole è su `feat/area7-f4` di stubwise-72), con le risposte F4-1…F4-6
e le decisioni di 46 del 13 nov 2026. Server, worker e
`@stubwise/api-client` sono di stubwise-72 (`feat/area7-f4`,
`feat/area7-f4-fix`); qui il renderer e i pezzi del motore condiviso che il
piano gli assegna (`feat/area7-f4-renderer`).

Nella build app la disponibilità della F4 è SPENTA (funzione
`automations-f4`) finché 46 non la accende, dopo la review del renderer.
I test di pagina la accendono col mock di `integration`.

## Renderer e motore condiviso (stubwise-94)

| Voce del prototipo | Build app | Test | Stato |
|---|---|---|---|
| L'inizio da un webhook e «avvia un'altra» nel costruttore (R1) | `AUTOMATION_F4_AVAILABILITY` in `@stubwise/shared` (la F3 più l'inizio `source`, solo webhook, e `startAutomation`); Audin e HubSpot restano «Coming soon». Gli allegati delle email restano fuori | `shared/automations/availability.test.ts`, `builder/BuilderPerimeter.test.tsx`, `ComingSoon.test.tsx` | fatto |
| La tinta con le sorgenti (R2) | la regola è quella della F3 (`taint.ts`): l'elemento di un elenco del payload letto da Claude tinge ciò che Claude ne ricava; una destinazione presa dall'elemento grezzo resta permessa, una decisa da Claude chiede l'approvazione | `shared/automations/taint.test.ts` | fatto |
| Le automazioni generali (R3) | `automations.general.manage` d'istanza (rinominato da `automations.manage`, che resta solo di progetto); la voce «General» e l'opzione «General (all projects)» solo a chi ha il permesso; la creazione manda `projectId: null`. `generalsAvailable()` = prototipo, o build app con `automations-f4` | `real/automationsF4Page.test.tsx`, `data/access/*.test.ts` | fatto |
| La pagina Sources e la tabella cliente → progetto (R4) | `real/automationSources.ts` sopra `client.automationSources` e `client.clientLinks`; 404 e 403 delle letture = niente. «Connect» c'è anche a elenco vuoto (il primo webhook nasce da lì) | `real/automationSources.test.ts`, `real/automationsF4Page.test.tsx` | fatto |
| Il segreto del webhook (R4, F4-1) | esce solo da creazione e rigenerazione: lo si tiene in memoria finché il pannello della sorgente è aperto; riaperta, l'indirizzo è nascosto («generane uno nuovo»), senza Copia | `real/automationsF4Page.test.tsx` | fatto |
| Gli eventi recenti di una sorgente (R4, F4-5, F4-6) | accanto alle esecuzioni partite, gli eventi che non ne hanno fatta partire nessuna: i rifiutati col motivo in parole (il campo con l'etichetta della sorgente e il tipo atteso; il corpo che non è JSON) e i doppioni | `real/automationsF4Page.test.tsx` | fatto |
| Il tetto del webhook (R4, F4-2 = c) | nell'«About» dell'automazione, solo se parte da un webhook e il server manda `webhookLimits`: il tetto che vale; chi la gestisce lo cambia (`PATCH webhookPerMinute/webhookPerDay`, vuoto = il default), col default e il massimo d'istanza detti accanto; oltre il massimo il server salva la scelta e la riga dice che vale il massimo | `real/automationsF4Page.test.tsx` | fatto (solo build app, vedi sotto) |
| «Remember for <client>» (R4, S5) | la casella solo con `permissions.rememberClient` (dettaglio dell'esecuzione) o `rememberClient` («Da decidere»), calcolati dal server; assenti = niente casella. Il prototipo calcola gli stessi campi con la stessa regola | `real/automationsF4Page.test.tsx`, `data/automations/curation.test.ts`, `Automations.test.tsx` | fatto |
| La prova con una sorgente (R5, 46: R5 = a) | l'esempio della sorgente dal server; il progetto dal cliente con la GET per chiave (`testClientProject`: la regola del worker, per il proprietario, mai la tabella), «in attesa» come Claude e poi si riprende; il progetto e le persone che porta entrano nei fatti della prova. Fuori tabella: «scegli il progetto», senza scrivere niente. Solo GET e `/tested` | `real/automationSimulate.test.ts` | fatto |
| «Avvia un'altra» nella prova (R6) | `context.automations` con `planStartAutomation` di shared, catena = questa: spenta, non gestibile, non vista, ciclo, coi codici dell'esecutore | `real/automationSimulate.test.ts` | fatto |
| «Avvia un'altra» nel costruttore e nell'esecuzione (R6) | il passo nomina l'altra dall'elenco vero; un avvio di sé stessa è il problema `limit` del server, in parole; il dettaglio dice la madre («by AUD-A0 #3») e le figlie coi codici del server | `real/automationsF4Page.test.tsx` (copertura di parità, verificata con tre mutazioni) | fatto |
| Un webhook per automazione (R6, F4-1 = a) | il 409 `source_in_use` all'accensione o alla pubblicazione si dice in parole, senza nominare l'altra (R-G5) | `real/automationsF4Page.test.tsx` | fatto |
| Le motivazioni dell'esecutore (R6) | `generalLost` e i codici del worker che cadevano su «Something went wrong» (`notAvailable`, `cancelledBy`, `suspended`, `emailAlreadySent`, `emailGone`, `emailCancelled`) hanno la loro frase; il test delle motivazioni guarda anche il worker (non `claude-step.ts`, che dà codici del provider) | `pages/automations/reasons.test.ts` | fatto |

### Differenze dichiarate

- Il tetto del webhook è solo della build app: il prototipo non ne ha uno
  (la riga non compare, `setWebhookLimits` del prototipo risponde
  `not_available`). Nel registro dei rimandi.
- La prova non conta le esecuzioni aperte dell'automazione da avviare (il
  freno `MAX_ACTIVE_RUNS` è dell'esecuzione vera; accettato con 72). Nel
  registro dei rimandi.
- La prova risolve il cliente già all'inizio (non è un passo, come nel
  prototipo): un server senza la rotta fa fallire l'inizio della prova con
  `not_available`, come gli altri agganci mancanti.
