# Area 8, fetta 2 — gli avvisi e le iscrizioni per progetto

> Bozza di stubwise-94 (13 nov 2026); fatta sua da stubwise-72 il 14 nov 2026
> con le risposte del maintainer (M-1 = a, M-2 = b) e un ruling sul modello
> dei dati (S1, sotto). Esecuzione: `feat/area8-f2` (server, 72; da
> `feat/area8-f1`, che la F2 usa: `release.failed`, i produttori, la 0176),
> `feat/area8-f2-renderer` (94).
> Design: `docs/plans/2026-11-13-integrazione-area8-design.md` (§ Fette F2,
> § Il modello dei dati F2, Review Focus F2, il lato renderer di 94 per la
> F2). Inventario e decisioni:
> `docs/plans/2026-11-13-integrazione-area8-inventario.md` (voce 7, S-4,
> R-5, M3). Specifica: il prototipo (`apps/desktop/src/renderer/domain/alerts/`,
> `data/alerts/`, `data/servers/alertTypes.ts`, `pages/preferences/`
> `NotificationsSection.tsx` e compagni, `layout/ProjectAlerts.tsx`,
> `.impeccable/shape/alerts.md`).

## Cosa entra

- **Il catalogo dei tipi di avviso in `@stubwise/shared`** (R-5 = a): tipi,
  famiglie, chi può iscriversi, il default di partenza, gli obbligatori, i
  partner di riga (`sameRowAs`). Una sola copia, letta da renderer, server e
  worker, con un test di parità sui `notification_kind`.
- **Le iscrizioni per persona e progetto**, per tipo e per canale («App» =
  la card in inbox, «Telefono» = il push): on, off, sospesa (derivata: il
  permesso manca adesso), obbligatoria (derivata: il catalogo).
- **I destinatari DERIVATI**: obbligatori sempre; gli iscritti secondo lo
  stato dell'iscrizione AL MOMENTO dell'avviso; tutti filtrati dai permessi
  e dalla visibilità di ADESSO (la revoca si applica a lettura).
- **Preferenze → Notifiche** e la scorciatoia «Mute» dalla colonna del
  progetto; «Copia da»; l'azione di Claude `setSubscription` (classe A,
  annullabile).
- **I tipi nuovi dell'area 8 e i `monitor.*` passano dal catalogo**; tutti
  gli altri `notification_kind` restano sul routing di oggi.

## Decisioni già prese

- **S-4 = a** *(O, 46)*: il catalogo copre i tipi nuovi dell'area 8 e i
  `monitor.*`; gli altri kind restano sul routing di oggi finché un'area non
  li porta, e le preferenze per canale di oggi (`slackDm`, `push`) restano.
  **Nessuna card di oggi cambia destinatari di colpo**: per ogni kind che
  passa al catalogo, i default di partenza riproducono i destinatari di oggi
  (vedi M-1 per i `monitor.*`), con un test che lo prova.
- **M3 = a** *(M)*: i tipi nuovi non vanno su Slack; i `monitor.*` smettono
  di andarci quando passano al catalogo, e la nota di rilascio lo dice.
- **R-5 = a** *(O)*: il catalogo è codice in shared, nessuna tabella.
- **M-1 = a** *(M, 14 nov 2026)*: i `monitor.*` nel catalogo partono accesi
  per chi ha `monitor.manage` nel progetto e spenti per gli altri membri, che
  possono iscriversi (nessuno riceve avvisi nuovi il giorno del deploy).
- **M-2 = b** *(M, 14 nov 2026)*: per i tipi del catalogo il «Telefono» del
  tipo SOSTITUISCE l'interruttore `push` delle preferenze; `push` vale solo
  per i kind di oggi. Il push resta legato a un device attivo.
- **Il modello dei dati** *(ruling di 72, 14 nov 2026; vedi S1)*: lo stato
  di ADESSO in `alert_subscriptions`, non la storia
  `alert_subscription_changes` della bozza.

## Fuori dalla F2

- I `notification_kind` di oggi fuori da area 8 e monitor (`ticket.created`,
  `request.created`, `job.*`, `review.completed`, `docs.nightly_attention`,
  `project.brief`, decisioni, Chat, Automazioni, `security.alert`): restano
  sul routing di oggi (S-4). Nel prototipo alcuni hanno già una riga nel
  catalogo (`sameRowAs`): nella build app quelle righe non si mostrano finché
  il loro kind non passa.
- I tipi senza produttore ancora: `support.request`,
  `support.customer_replied` (F3), `task.created_by_automation` (area 7),
  `server.*` dell'analisi (F4). Sono nel catalogo condiviso, ma la build app
  non li mostra finché il server non li pubblica (vedi «I tipi vivi»).
- Slack per i tipi del catalogo (M3).
- «Non avvisarmi più di questo» dalla card (`muteFromNotification`): nel
  prototipo non ha un consumatore in pagina; si decide con la UI dell'inbox,
  e il server lo prevede (S6) perché costa poco.

## Il catalogo in shared

`packages/shared/src/alerts/catalog.ts` (da `domain/alerts/catalog.ts` del
prototipo più `data/servers/alertTypes.ts`), puro:

- `AlertType { type, group, labelKey, subscribe: { perm | "member" },
  defaultOn: DefaultRule, defaultPhone, mandatory: MandatoryReason[],
  mandatoryOnly?, sameRowAs?, defaultForFullAdmins? }`.
- `defaultOn` diventa un DATO, non una funzione: `"off" | "members" | { perm:
  Permission }` (oggi `off`, `members`, `holds(perm)`), perché lo legga anche
  il server.
- `MandatoryReason`: `merged` | `pr_author` | `task_author` | `assignee` |
  `follows_conversation`.
- `ALERT_TYPES`, `alertTypeOf`, `rowTypeOf`, `rowPartners`, `isCatalogKind`.
  Nessun `registerAlertTypes`: le righe dell'area 8b entrano nel file.
- **I tipi vivi**: `LIVE_ALERT_TYPES` (o un campo `since: "f2" | "f3" | …`)
  dice quali tipi il server pubblica. Il server elenca nelle iscrizioni solo
  quelli; il prototipo li mostra tutti.
- **Test di parità** (`catalog.test.ts`): ogni tipo vivo è un valore di
  `notificationKindSchema`; ogni `sameRowAs` punta a un tipo del catalogo;
  nessun tipo vivo è nella lista dei kind a destinatari fissi
  (`security.alert`, `DECISION_NOTIFICATION_KINDS`, Chat, Automazioni).

## I tipi della F2

| Tipo | Famiglia | Chi può iscriversi | Default | Obbligatori | Oggi |
|---|---|---|---|---|---|
| `release.merged` | releases | membro | off | — | nuovo |
| `release.succeeded` | releases | membro | off | — | nuovo |
| `release.failed` | releases | membro | `release.merge` | `merged`, `task_author` | routing della F1 (stessi destinatari) |
| `pr.opened` | prs | membro | off | — | nuovo |
| `pr.analysis_issues` | prs | `repos.view` | `release.merge` | `pr_author` | nuovo |
| `pr.corrected` | prs | `repos.view` | — (solo obbligatorio) | `pr_author` | nuovo |
| `docs.release_note` | docs | `docs.view` | off | — | nuovo |
| `monitor.alert` | monitor | membro | M-1 | — | routing (`monitor.manage`) |
| `monitor.recovered` | monitor | membro | M-1 | — | routing (`monitor.manage`) |

Ogni `notification_kind` nuovo è un passo di rollback (CLAUDE.md, deploy).

## Task del SERVER (interfacce e test; l'implementazione è di 72)

S1. **La migrazione**:
   - `alert_subscriptions` (`user_id`, `project_id`, `alert_type`, `app`,
     `phone`, `updated_at`), unico `(user_id, project_id, alert_type)`: lo
     stato di ADESSO, scritto con un upsert; nessuna riga = il default del
     catalogo dai permessi di adesso. Il «mute» è uno spegnimento come gli
     altri. **Ruling (72) sulla storia della bozza
     (`alert_subscription_changes`)**: sul server la card NASCE alla
     pubblicazione, per i destinatari di quel momento, quindi «lo stato al
     momento dell'avviso» è lo stato di adesso letto alla pubblicazione, e
     nessuna lettura chiede mai il passato; la revoca a lettura vuole i soli
     permessi di adesso, e l'«Annulla» di copia e mute vive delle righe di
     prima che le rotte restituiscono. La storia serviva al prototipo, che
     deriva le card a lettura; qui sarebbe una tabella che cresce senza un
     lettore. Se un domani servisse un registro, si aggiunge senza toccare
     questa.
   - I `notification_kind` nuovi della tabella sopra, ognuno in uno
     statement a sé e mai usato nello stesso batch.
   *Test*: i vincoli, la parità degli enum.

S2. **I destinatari** (`packages/notifications`). Solo gli eventi con un
   PROGETTO passano dal catalogo: un `monitor.*` di un server senza un solo
   progetto (`apps/worker/src/monitor/alerts.ts` passa `projectId` solo se il
   legame è univoco) resta sul routing di oggi, perché le iscrizioni sono per
   progetto.
   - una funzione pura `catalogRecipients(event, ctx)`: gli obbligatori del
     tipo (`mandatory` risolto dal produttore: chi ha fatto il merge, l'autore
     collegato della PR, l'autore della task, l'assegnatario), più i membri
     del progetto la cui iscrizione è accesa ADESSO (la voce più recente, o
     il default del catalogo dai permessi di adesso), meno chi non può
     iscriversi (`subscribe.perm`);
   - alla pubblicazione la card nasce per quei destinatari: la storia
     dell'iscrizione al momento dell'avviso È l'istante della
     pubblicazione. Il push solo a chi ha «Telefono» acceso per quel tipo
     (M-2 = b: con una riga d'iscrizione `push` delle preferenze non conta) e
     un device attivo; SENZA riga il Telefono di partenza è `defaultPhone` E
     l'interruttore `push` di oggi, così il giorno del deploy chi ha `push`
     spento non riceve un telefono nuovo (46, 14 nov 2026; test con
     `notify_push = false` e nessuna riga); Slack mai (M3);
   - a lettura (inbox, push già nato non si richiama) restano i filtri di
     oggi: chi non vede più il progetto o ha perso `subscribe.perm` non vede
     la card (la revoca a lettura), e la rivede se lo riacquista.
   *Test*: obbligatori con l'iscrizione spenta; iscritti al momento
   dell'avviso (spegnere vale per il futuro); permesso perso a lettura;
   nessuna card su Slack per un tipo del catalogo; il push solo col Telefono
   (anche con `push` spento nelle preferenze, e mai col Telefono spento e
   `push` acceso); un `monitor.*` senza progetto come oggi.

S3. **S-4, nessun cambio di colpo**: per `release.failed` e i `monitor.*`
   un test a DUE momenti (stessi dati, prima e dopo il passaggio al
   catalogo) che prova che i destinatari non cambiano per chi non ha toccato
   niente: `release.failed` resta a chi ha fatto il merge e a chi ha
   `release.merge`; i `monitor.*` come dice M-1.

S4. **I produttori** dei tipi nuovi, sui punti che la F1 ha già:
   `release.merged` (S3 della F1, alla nascita del rilascio),
   `release.succeeded` (S4, al passaggio a `succeeded`, una volta),
   `pr.opened` (il webhook di una PR aperta su un repository collegato),
   `pr.analysis_issues` (la review con problemi), `pr.corrected` (una
   correzione spinta sul ramo di un collega), `docs.release_note` (la nota
   notturna scritta). Ognuno una volta per fatto (idempotente sulle
   riconsegne). *Test* per ognuno.

S5. **Le rotte delle iscrizioni** (`/api/me/alert-subscriptions`):
   - `GET` → `{ items: ProjectSubscriptions[] }`: per ogni progetto visibile,
     le righe dei tipi vivi che chi chiede può vedere, con `app`, `phone`,
     `state` (on | off | suspended | mandatory), `suspendedReason` (il
     permesso che manca) e `mandatory` (i motivi). Il calcolo è del server
     (il client legge, non deduce);
   - `PUT /:projectId/:type` `{ app?, phone? }` (patch; scrive anche i
     partner di riga): 403 su un tipo che non si può scrivere (sospeso,
     solo obbligatorio), 404 un progetto invisibile;
   - `POST /:projectId/copy` `{ fromProjectId }` e `POST /:projectId/mute`:
     rispondono con le righe di PRIMA, per l'«Annulla» (il client le
     riscrive con `PUT`).
   *Test* negativi sui permessi; il progetto invisibile come inesistente.

S6. **«Non avvisarmi più di questo»**: `POST /api/inbox/:id/mute-type`
   (spegne il tipo della card, e della sua riga, nel suo progetto; 403 se la
   card è arrivata per un motivo obbligatorio, 422 un kind fuori dal
   catalogo). Previsto, il renderer lo accende con la UI dell'inbox.

S7. **L'azione di Claude `setSubscription`** (classe A, annullabile) nel
   catalogo delle azioni, coi permessi di chi chiede.

S8. **Il client e le forme** (`packages/api-client`, `@stubwise/shared`):
   `client.alerts.list/set/copy/mute`, le forme di S5; campi nuovi
   facoltativi, con un test che parsa una risposta senza.

S9. **Il deploy-log**: la voce della F2 (la migrazione, i kind nuovi nel
   rollback, la nota di rilascio su Slack e i `monitor.*`, M3).

**Coordinamento.** Il catalogo in shared (R1) serve anche al server: lo
scrive 94 per primo, sopra `feat/area8-f2` (un file in
`packages/shared/src/alerts/`, nessun altro file toccato), e 72 parte da S1
e dai `notification_kind` nuovi intanto; S2–S7 leggono il catalogo.

## Task del RENDERER (94)

R1. **Il catalogo in shared**: lo sposto in `packages/shared/src/alerts/`
   (puro, `defaultOn` come dato), il prototipo lo importa da lì (come
   `calendar-grid.ts`), `data/servers/alertTypes.ts` sparisce (le sue righe
   entrano nel file), il test di parità. `domain/alerts/recipients.ts` resta
   del prototipo (nella build app i destinatari li calcola il server), ma
   legge il catalogo condiviso.
   *Test*: i test di oggi di `domain/alerts` e `data/alerts` verdi senza
   modifiche di comportamento; mutazione su `defaultOn`.

R2. **L'adattatore** `data/backend/real/alerts.ts` su `client.alerts`, con
   le firme del prototipo (`subscriptionRows`, `setSubscription`,
   `copySubscriptions`, `muteProject`; `muteFromNotification` quando S6 c'è):
   le righe e gli stati dal server; l'«Annulla» di copia e mute riscrive le
   righe di prima con `PUT`; 404 e 403 nelle parole del prototipo.
   *Test* sull'interfaccia (come `releasePrs.test.ts`).

R3. **Preferenze → Notifiche** (`pages/preferences/NotificationsSection.tsx`,
   `GroupMenu.tsx`, `useAlertActions.ts`) e la scorciatoia «Mute» della
   colonna (`layout/ProjectAlerts.tsx`), accese con la funzione `alerts`:
   - solo le righe dei tipi vivi che il server manda (le altre famiglie
     vuote non si mostrano);
   - il «Telefono» di un tipo del catalogo vale da solo (M-2 = b): nessun
     legame con `push` delle preferenze, che resta per i kind di oggi;
   - un tipo obbligatorio non si spegne, uno sospeso lo dice in parole;
   - regola I1 (area 7): nessuna azione che il server non ha.
   *Test di pagina* col fakeServer: le righe, una scrittura (la `PUT` esatta),
   «Mute» con l'«Annulla», l'obbligatorio non spegnibile, il sospeso.

R4. **Le card dei tipi nuovi nell'inbox**: in
   `data/backend/real/notifications.ts` il link nell'app di ognuno (il
   rilascio, il pannello della PR `?pr=`, la pagina dei Docs, il server).
   Le card arrivano già oggi senza rompere («Open in web»).
   *Test*: ogni kind nuovo apre la sua pagina; una card parsata senza i
   campi nuovi (regola additiva).

R5. **L'azione di Claude `setSubscription`**: l'adattatore nel catalogo
   delle azioni della build app, con la riga «Undo» del prototipo.

R6. **`INTEGRATED_CALLS` e i test d'accensione** nello stesso commit
   (regola I3), con «aprire Preferenze → Notifiche legge solo chiamate
   integrate».

R7. **Parità** (`apps/desktop/docs/integration-area8-f2.md`) e registro.

## Global Constraints

- I permessi li calcola il server; nascosto = inesistente, anche negli
  avvisi già arrivati (la revoca a lettura).
- S-4: nessuna card di oggi cambia destinatari di colpo; i kind fuori dal
  catalogo restano sul routing di oggi.
- M3: niente Slack per i tipi del catalogo.
- Ogni `notification_kind` nuovo è un passo di rollback; campi additivi con
  default verso i client.
- Il catalogo è UNO (shared): nessuna copia nel server né nel renderer.
- TDD con mutazioni sui destinatari, sugli obbligatori e sulla parità.

## Review Focus

- Un obbligatorio arriva anche con l'iscrizione spenta; un tipo
  `mandatoryOnly` non si iscrive né si spegne.
- Spegnere vale per il futuro: la card già arrivata resta.
- Un permesso perso nasconde le card a lettura senza riscrivere righe, e le
  rimostra se torna.
- Nessun destinatario cambia per chi non ha toccato niente (S3).
- Il push rispetta sia il Telefono del tipo sia `push` della persona; Slack
  mai per un tipo del catalogo.
- I partner di riga (`sameRowAs`) si scrivono insieme.

## Domande del maintainer — risposte *(M, 14 nov 2026)*: M-1 = a, M-2 = b

M-1. **I `monitor.*` quando passano al catalogo: chi li riceve senza aver
   toccato niente.** Oggi vanno solo a chi ha `monitor.manage` nel progetto
   (audience «deciders»); il prototipo li dà accesi a ogni membro del
   progetto.
   - (a) *(consigliata: S-4 alla lettera, nessuno riceve avvisi nuovi il
     giorno del deploy)* Il default riproduce oggi: acceso per chi ha
     `monitor.manage`, spento per gli altri membri, che possono iscriversi.
   - (b) Il default del prototipo: acceso per ogni membro del progetto (chi
     non li vuole li spegne).
   - (c) Come (a), e il prototipo si allinea ad (a), così specifica e app
     dicono la stessa cosa.

M-2. **Il «Telefono» per tipo e l'interruttore `push` di oggi.**
   - (a) *(consigliata)* `push` resta l'interruttore generale della persona:
     spento, nessun push per nessun tipo; acceso, decide il «Telefono» di
     ogni tipo. Nelle Preferenze il Telefono di un tipo si mostra spento
     (con il perché) quando `push` è spento.
   - (b) Il «Telefono» per tipo sostituisce `push` per i tipi del catalogo
     (`push` vale solo per i kind di oggi).
