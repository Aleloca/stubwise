# Integrazione area 8, fetta 2 «Avvisi» — parità col prototipo (14 nov 2026)

Cosa degli avvisi e delle iscrizioni per progetto del prototipo arriva sul
server vero nella fetta 2 dell'area 8. Piano:
`docs/plans/2026-11-13-integrazione-area8-fetta2-plan.md` (su
`feat/area8-f2`), con le risposte del maintainer M-1 = a e M-2 = b. Server,
worker, `@stubwise/notifications` e `@stubwise/api-client` sono di
stubwise-72 (`feat/area8-f2`); qui il renderer e il catalogo condiviso che il
piano gli assegna (`feat/area8-f2-renderer`).

Nella build app sono ACCESE `alerts` (Preferenze → Notifiche, la campanella
del progetto, il menu degli avvisi nel pannello) e `alerts-mute` («Don't
alert me» dalla card), con le loro chiamate in `INTEGRATED_CALLS` (regola
I3 dell'area 7). L'azione di Claude `setSubscription` (R5) passa dal
canale generico delle azioni, già acceso (`claude-actions`): nessuna
chiamata nuova del renderer.

## Renderer e moduli condivisi (stubwise-94)

| Voce del prototipo | Build app | Test | Stato |
|---|---|---|---|
| Il catalogo dei tipi di avviso (R1) | `@stubwise/shared` (`alerts/catalog.ts`), puro, lo stesso del server e del worker: chi può iscriversi (`subscribe`), il default di partenza come DATO (`defaultOn`: `off`, `members` o `{perm}`), il Telefono di partenza, gli obbligatori (`mandatory`, `mandatoryOnly`), le righe condivise (`sameRowAs`), i full admin (`defaultForFullAdmins`); `LIVE_ALERT_TYPES` dice cosa il server pubblica davvero e `liveRowTypes` le righe che l'app mostra. Le righe dei server (area 8b) sono nel file (prima le registrava `data/servers/alertTypes.ts`, tolto) | `shared/alerts/catalog.test.ts` (anche la parità con `notificationKindSchema` e i kind coi destinatari fissi mai nel catalogo) | fatto |
| Il default dei `monitor.*` | `appDefaultOn = {perm: "monitor.manage"}` solo per la build app (M-1 = a: chi li riceve oggi, nessun cambio di destinatari al deploy); il prototipo NON lo legge e resta «tutti i membri» | `shared/alerts/catalog.test.ts`, `domain/alerts/recipients.test.ts` | fatto |
| Il prototipo sul catalogo condiviso | `domain/alerts/catalog.ts` ne fa una copia mutabile (`registerAlertTypes` resta il punto d'estensione dei test) e restringe i permessi a `Permission` in un posto; `ruleApplies` legge `defaultOn`. `domain/alerts/recipients.ts` resta del prototipo (nella build app i destinatari li calcola il server) | `domain/alerts/recipients.test.ts` (ogni permesso del catalogo è noto al prototipo), `data/alerts/alerts.test.ts`, `data/servers/analysis.test.ts` | fatto |
| Le card dei tipi nuovi nell'inbox (R4) | `appLinkFor` in `real/notifications.ts`: l'`url` `/app/#/p/<PRJ>/…` che il server scrive (S1) apre la pagina nell'app se è dell'istanza e la pagina è accesa: il rilascio (`releases`), il pannello della PR (`releases-prs`, `?pr=<repository>%23<n>`), i Docs del progetto. Altrimenti «Open in web»; un'altra origine mai nell'app; una card senza `url` (server più vecchio) non rompe | `real/session.test.ts`, `real/releasesPrsPage.test.tsx` (il pannello dall'URL e dalla riga) | fatto |
| Il `?pr=` del router | accetta anche `<id>#<numero>`, l'id di una PR nella build app (difetto della F1: il pannello non si apriva, corretto anche su `feat/area8-f1-renderer`) | `real/releasesPrsPage.test.tsx` | fatto |
| Le iscrizioni: elenco, scrittura, copia, «Mute» (R2) | `real/alerts.ts` su `client.alerts.list/set/copy/mute`, con le firme del prototipo: i progetti seguiti prima (i fissati), le righe e gli stati dal server, una riga di stato sconosciuto non si mostra; `setSubscription` scrive la RIGA (`monitor.alert` → `server.trouble`); l'«Annulla» di copia e «Mute» riscrive con `PUT` le righe di prima con una scelta salvata (`saved`) e riporta al default con `DELETE` le altre (review F2: fissarle toglierebbe al Telefono il legame con `push`); da un server più nuovo un tipo che l'app non conosce non si mostra, il gruppo è quello del catalogo dell'app, dei motivi obbligatori restano quelli noti; i seguiti che non si leggono non fermano niente (nessun fissato); gli errori nelle parole del prototipo | `real/alerts.test.ts` | fatto |
| Preferenze → Notifiche e la campanella del progetto (R3) | `/preferences/notifications` è della funzione `alerts` (le altre sezioni delle Preferenze restano della loro area); il Telefono di un tipo del catalogo vale da solo (M-2 = b) e la nota ⓘ dice che arriva come push sul telefono; senza riga il server lo calcola (`defaultPhone` e `notify_push`), il client lo legge; un obbligatorio non si spegne e dice se arriva anche sul telefono (il valore del server); una riga spenta con un obbligo dice che quando ti riguarda arriva lo stesso nell'app, e sul telefono se il Telefono del server è acceso (solo build app; una sospesa non promette niente); un sospeso lo dice in parole. La campanella del progetto c'è solo con `alerts`. «Security off» nella colonna delle Preferenze solo dove la sezione Sicurezza è accesa (area 9) | `real/alertsPage.test.tsx` (anche la PUT esatta, «Mute» con «Undo», le letture assenti a funzione spenta) | fatto |
| L'azione di Claude `setSubscription` (R5) | la esegue il server (S7, classe A) e la riga e l'«Undo» passano dal canale generico dei gruppi (`/groups`, `POST /api/claude/groups/:id/undo`). Il server non dà codici: la riga dice il codice del progetto dal `projectId` («Changed your alerts in AUD», come nel prototipo) e il riassunto della scheda si scrive dagli argomenti (l'etichetta del tipo dal catalogo condiviso, solo i canali presenti). L'inverso di una riga senza scelta salvata è `resetSubscription` («back to the default», mai proposto). Il codice del progetto viene dal solo elenco dei progetti e, se non si legge, la riga resta senza codice; senza canali il riassunto non finisce con «: ». Dopo l'azione e dopo l'«Undo» Preferenze → Notifiche rilegge le iscrizioni; un'azione che la build non conosce (`__unknown__`) ha la frase generica, non una chiave grezza | `real/claudeChatActions.test.ts`, `real/claudeChatActionsPage.test.tsx`, `data/queries.test.tsx` | fatto |
| `INTEGRATED_CALLS` e l'accensione (R6) | `alerts` e `alerts-mute` accese; le cinque chiamate `alerts.*` in `INTEGRATED_CALLS` | `pages/ComingSoon.test.tsx` («aprire Preferenze → Notifiche legge solo chiamate integrate») | fatto |
| «Non avvisarmi più di questo» dalla card (S6) | `muteFromNotification` su `client.inbox.muteType`: il server spegne la riga del tipo della card nel suo progetto; l'«Annulla» riscrive la riga di prima nel progetto della risposta (o la riporta al default se non era salvata) (senza progetto, da un server più vecchio, lo dice invece di scrivere); funzione `alerts-mute` | `real/alerts.test.ts`, `real/alertsPage.test.tsx` | fatto |
| «Ti arriva perché…» | `alertMandatory` dell'`InboxItem` (scritto alla pubblicazione per ogni destinatario) diventa il `mandatory` della card: il pannello dice il motivo e non offre «Don't alert me»; un motivo sconosciuto non si mostra | `real/session.test.ts`, `real/alertsPage.test.tsx` | fatto |

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
