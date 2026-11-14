# Integrazione area 8, fetta 2 «Avvisi» — parità col prototipo (14 nov 2026)

Cosa degli avvisi e delle iscrizioni per progetto del prototipo arriva sul
server vero nella fetta 2 dell'area 8. Piano:
`docs/plans/2026-11-13-integrazione-area8-fetta2-plan.md` (su
`feat/area8-f2`), con le risposte del maintainer M-1 = a e M-2 = b. Server,
worker, `@stubwise/notifications` e `@stubwise/api-client` sono di
stubwise-72 (`feat/area8-f2`); qui il renderer e il catalogo condiviso che il
piano gli assegna (`feat/area8-f2-renderer`).

Documento in corso: le righe «in attesa» si chiudono quando 72 ha le rotte
delle iscrizioni (S5) e il client (S8, `client.alerts`). Nessuna funzione
nuova è accesa nella build app finché R6 non c'è (regola I3 dell'area 7:
`INTEGRATED_CALLS` cresce nello stesso commit dell'accensione).

## Renderer e moduli condivisi (stubwise-94)

| Voce del prototipo | Build app | Test | Stato |
|---|---|---|---|
| Il catalogo dei tipi di avviso (R1) | `@stubwise/shared` (`alerts/catalog.ts`), puro, lo stesso del server e del worker: chi può iscriversi (`subscribe`), il default di partenza come DATO (`defaultOn`: `off`, `members` o `{perm}`), il Telefono di partenza, gli obbligatori (`mandatory`, `mandatoryOnly`), le righe condivise (`sameRowAs`), i full admin (`defaultForFullAdmins`); `LIVE_ALERT_TYPES` dice cosa il server pubblica davvero e `liveRowTypes` le righe che l'app mostra. Le righe dei server (area 8b) sono nel file (prima le registrava `data/servers/alertTypes.ts`, tolto) | `shared/alerts/catalog.test.ts` (anche la parità con `notificationKindSchema` e i kind coi destinatari fissi mai nel catalogo) | fatto |
| Il default dei `monitor.*` | `appDefaultOn = {perm: "monitor.manage"}` solo per la build app (M-1 = a: chi li riceve oggi, nessun cambio di destinatari al deploy); il prototipo NON lo legge e resta «tutti i membri» | `shared/alerts/catalog.test.ts`, `domain/alerts/recipients.test.ts` | fatto |
| Il prototipo sul catalogo condiviso | `domain/alerts/catalog.ts` ne fa una copia mutabile (`registerAlertTypes` resta il punto d'estensione dei test) e restringe i permessi a `Permission` in un posto; `ruleApplies` legge `defaultOn`. `domain/alerts/recipients.ts` resta del prototipo (nella build app i destinatari li calcola il server) | `domain/alerts/recipients.test.ts` (ogni permesso del catalogo è noto al prototipo), `data/alerts/alerts.test.ts`, `data/servers/analysis.test.ts` | fatto |
| Le card dei tipi nuovi nell'inbox (R4) | `appLinkFor` in `real/notifications.ts`: l'`url` `/app/#/p/<PRJ>/…` che il server scrive (S1) apre la pagina nell'app se è dell'istanza e la pagina è accesa: il rilascio (`releases`), il pannello della PR (`releases-prs`, `?pr=<repository>%23<n>`), i Docs del progetto. Altrimenti «Open in web»; un'altra origine mai nell'app; una card senza `url` (server più vecchio) non rompe | `real/session.test.ts`, `real/releasesPrsPage.test.tsx` (il pannello dall'URL e dalla riga) | fatto |
| Il `?pr=` del router | accetta anche `<id>#<numero>`, l'id di una PR nella build app (difetto della F1: il pannello non si apriva, corretto anche su `feat/area8-f1-renderer`) | `real/releasesPrsPage.test.tsx` | fatto |
| Le iscrizioni: elenco, scrittura, copia, «Mute» (R2) | `real/alerts.ts` su `client.alerts.list/set/copy/mute`, con le firme del prototipo; l'«Annulla» riscrive le righe di prima con `PUT` | — | in attesa di S5, S8 |
| Preferenze → Notifiche e «Mute» della colonna (R3) | solo le righe dei tipi vivi che il server manda; il Telefono di un tipo del catalogo vale da solo (M-2 = b) e, senza riga, è quello che il server calcola (`defaultPhone` e `notify_push`): il client lo legge, non lo deduce; un obbligatorio non si spegne, un sospeso lo dice; «ti arriva perché…» da `event.alertMandatory` | — | in attesa di S5, S8 |
| L'azione di Claude `setSubscription` (R5) | l'adattatore nel catalogo delle azioni della build app, con l'«Undo» del prototipo | — | in attesa di S7, S8 |
| `INTEGRATED_CALLS` e l'accensione (R6) | nello stesso commit dell'accensione, con «aprire Preferenze → Notifiche legge solo chiamate integrate» | — | in attesa di R2, R3 |

### Differenze dichiarate

- Le card degli avvisi dei server (`monitor.*`, e i `server.*` quando
  saranno pubblicati) restano «Open in web» finché la sezione Servers non è
  integrata (fetta Servers dell'area 8).
- Il catalogo condiviso nomina i permessi come stringhe: ci sono quelli del
  registro (di progetto, e `monitor.manage` d'istanza) e quelli che vivono
  ancora solo nel prototipo (`support.reply`, `servers.operate`). Il
  prototipo li restringe a `Permission`; un test lo tiene onesto.
- Le iscrizioni sul server sono lo stato di ADESSO (nessuna storia,
  decisione nel registro dei rimandi): nella build app spegnere vale da
  subito per le card nuove, come nel prototipo.
