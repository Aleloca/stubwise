# Integrazione area 4 — Chat, fetta 4: eventi dei progetti e allegati — piano (11 nov 2026)

> Autore: stubwise-72 (server e worker), renderer a stubwise-94. **Solo il
> piano**: niente codice né golden finché l'orchestratrice non dà il via
> (quota ferma per le review della fetta 2). Il branch sarà
> `feat/area4-f4-server`, da `feat/area4-f3-server`.
>
> **Specifica**: il prototipo.
> - `apps/desktop/src/renderer/data/chat/events.ts` (`publishChatEvent`, `eventText`);
> - `data/chat/constants.ts` (`CHAT_EVENT_KINDS`);
> - `data/chat/writes.ts` (`setPublishedEvents`, `canEditEvents`, gli allegati di `sendMessage`/`editMessage`/`deleteMessage`, `scrubDeleted`);
> - `data/chat/reads.ts` (`searchChat`: «con allegati» e i nomi degli allegati nella ricerca);
> - `pages/chat/SystemCard.tsx`;
> - il design `docs/plans/2026-10-25-desktop-area4-chat-design.md`, §«Eventi dei progetti nel canale».
>
> **Decisioni già prese**:
> - dal design del prototipo (maintainer): gli eventi dei progetti sono messaggi di SISTEMA nel «general», o in un canale scelto, con la scheda dell'oggetto; il webhook in uscita resta;
> - D8: il «general» nasce con Release, traguardi e brief accesi.
>
> Registro, area 4: il filtro «con allegati» della ricerca.

## Dove siamo

- `chat_channels.published_events` c'è dalla 0135, con i default del
  «general». Lo schema shared ha `CHAT_EVENT_KINDS`, ma nessuno PUBBLICA
  niente: la colonna è inerte, e manca anche la rotta per cambiarla
  (`setPublishedEvents`).
- Nessun messaggio `system` viene scritto. I conteggi li trattano già come il
  prototipo: contano fra i non letti col livello «tutti», mai come menzioni
  (`channelViewsBatch`).
- Gli allegati dei ticket esistono (`attachments`, `routes/attachments.ts`):
  10 MB, allowlist MIME, storage con URL firmati, binario mai dall'API. Quelli
  della Chat no: il renderer manda `attachments: []`.

## Perimetro

1. **Gli eventi**: un messaggio `system` in OGNI canale di PROGETTO, non
   archiviato, che pubblica quell'evento. Nessun canale generale né DM.
   - Le fonti sul server:

     | Evento | Quando |
     |---|---|
     | `task_closed` | una task passa alla famiglia «closed», da qualunque scrittura (task, bulk, pipeline, merge) |
     | `request_new` | nasce una richiesta NUOVA (intake, a mano, MCP); una fusione in una richiesta che c'è già no |
     | `milestone_reached` | un traguardo passa a chiuso |
     | `brief_ready` | il worker scrive un brief settimanale |
     | `pr_opened` | la pipeline (o l'adozione) dà la PR a una task |
     | `pr_merged` | la PR di una task risulta mergiata |
     | `release_page` | **[DECIDE] 1** |

   - **La scheda** (`SystemCard`): l'evento e l'oggetto, nel messaggio
     (`event: {kind, ref}`). Il testo si DERIVA a lettura e il messaggio salvato
     ha `body` vuoto. La regola è quella delle citazioni: chi legge il canale ma
     non vede la task o la richiesta legge il codice senza il titolo, e un
     oggetto che non c'è più (una task eliminata) mostra solo il tipo
     dell'evento.
   - **Non avvisano**: nessuna card, nessuna push. Contano fra i non letti col
     livello «tutti», come nel prototipo.
2. **`setPublishedEvents`**: `PUT /api/chat/channels/:id/events {events}`,
   solo con `canEditEvents` (canali di progetto, il creatore o chi gestisce,
   non archiviati), su un elenco chiuso (`CHAT_EVENT_KINDS`). Si scrive in
   ordine canonico, come il prototipo.
3. **Gli allegati dei messaggi**.
   - Si caricano nel canale prima di mandare il messaggio, poi il messaggio li
     lega: `POST /api/chat/channels/:id/attachments` (multipart), solo per chi
     scrive nel canale. Restano «in sospeso» per chi li ha caricati finché un
     suo messaggio di quel canale non li lega.
   - Si scaricano con un URL firmato, solo da chi LEGGE il canale (la regola
     di `access.ts`, DM e privati compresi).
   - Limiti e MIME sono quelli dei ticket, salvo **[DECIDE] 2**.
   - Un messaggio può nascere con soli allegati e senza testo, come nel
     prototipo. Oggi il testo è obbligatorio, e diventa facoltativo solo se ci
     sono allegati.
   - Una modifica toglie o tiene gli allegati (`attachmentIds` del body), ma
     non ne aggiunge di nuovi: il prototipo non lo fa.
   - Eliminare il messaggio porta via gli allegati, righe e oggetti nello
     storage (`scrubDeleted`); lo storage si pulisce senza bloccare.
4. **La ricerca**:
   - il filtro «con allegati» (`withAttachments`), messo in pausa nella fetta 2;
   - i NOMI degli allegati dentro `search_folded`, come il prototipo
     (`haystack` = testo, nomi degli allegati, codici citati).
5. **Fuori**:
   - la struttura del Drive per gli allegati (area 5);
   - le regole complesse degli eventi (area 7, automazioni);
   - gli eventi delle aree non integrate, salvo [DECIDE] 1.

## [DECIDE] per l'orchestratrice

1. **`release_page`: da dove nasce.** Il «general» lo ha acceso di default
   (D8), ma la «pagina di Release» del prototipo è un oggetto dell'area 8, non
   ancora integrata. Sul server, oggi, l'oggetto più vicino sono le **note di
   rilascio** del giro notturno (`doc_pages` di kind `releases`, con
   `significant`).
   - **(a, consigliata)** Aspettare l'area 8: `release_page` resta senza fonte,
     acceso ma inerte, e la sua scheda nasce quando l'area 8 definisce la
     pagina di Release. Così non si lega la Chat a un oggetto che l'area 8
     potrebbe ridefinire.
   - (b) Usare subito le note di rilascio significative del giro notturno: una
     scheda «Release notes: <titolo>» che apre la pagina Docs. Nel prototipo la
     Release è un'altra cosa, quindi va rivista con l'area 8.
2. **Allegati: tetto e tipi.**
   - **(a, consigliata)** Gli stessi dei ticket: 10 MB per file, l'allowlist
     MIME di `routes/attachments.ts`, fino a 10 allegati per messaggio. Una
     sola regola per gli allegati di tutto Stubwise.
   - (b) Un tetto della Chat a sé (per esempio 25 MB e tipi più larghi, come
     zip o video brevi), con il suo allowlist.
3. **Conservazione degli allegati in sospeso** (caricati e mai mandati).
   - **(a, consigliata)** Il worker li pota dopo 24 ore, righe e oggetti nello
     storage, come igiene. Non si vedono a nessuno, nemmeno a chi li ha
     caricati, fuori dalla casella che li ha caricati.
   - (b) Restano finché chi li ha caricati non li toglie a mano.

## Il modello (tecnico, mie scelte)

- **Migrazione 0141** (il primo numero libero; lo ricontrollo prima di
  scriverla):
  - `chat_messages.event_kind` e `event_ref_kind`/`event_ref_id`, con un CHECK:
    solo sui messaggi `system`, sull'elenco chiuso;
  - la tabella `chat_message_attachments (id, channel_id, message_id null,
    uploader_id, filename, mime_type, size_bytes, storage_key unico,
    created_at)`, in cascata sul messaggio e sul canale;
  - i TRIGGER degli eventi (sotto).
- **Gli eventi li scrive un TRIGGER del database**, come il «general»:
  - `AFTER UPDATE` su `tickets` (famiglia → closed);
  - `AFTER INSERT` su `backlog_items` (non fusa);
  - `AFTER UPDATE` su `milestones` (chiuso false → true);
  - `AFTER INSERT` su `project_briefs`;
  - `AFTER INSERT OR UPDATE` su `ticket_repositories` (`pr_url` che nasce,
    `pr_state` → `merged`).

  Una funzione sola, `chat_publish_event(project, kind, ref_kind, ref_id)`,
  scrive un messaggio `system` in ogni canale di progetto non archiviato che
  pubblica `kind`, porta avanti `updated_at` e manda il NOTIFY dello stream
  della Chat. Il motivo è lo stesso del «general»: copre OGNI scrittore (le
  rotte, la pipeline del worker, l'intake, il merge da webhook), non solo una
  rotta. È fail-safe per costruzione: un canale non c'è più, e la funzione non
  scrive niente.
- **La vista**: `event: { kind, ref: {kind, id}, label, title } | null` sul
  messaggio, derivata con `citeablesFor` (la regola di chi legge). Il testo
  della scheda lo compone il renderer, come `SystemCard` del prototipo.
- **Allegati**: lo storage di sempre (`app.storage()`), con le chiavi sotto
  `chat/<canale>/<id>`. Nessun binario passa dall'API: si carica con multipart,
  si scarica con un URL firmato. `attachmentIds` su `postChatMessageSchema` e
  `editChatMessageSchema`, opzionali e additivi.
- **Potatura** (se [DECIDE] 3 = a): un passo del worker, con le altre potature.

## Task

- **F4.1 — DB e schemi**: 0141, `schema.ts`, `event` e `attachments` sul
  messaggio, i body. Test: la migrazione (i trigger su ogni fonte, una fusione
  che non pubblica, un archiviato che non riceve), il parse di un messaggio
  della fetta 3.
- **F4.2 — Eventi**: i trigger, la vista derivata, `PUT …/events`. Test: ogni
  fonte; un canale che non pubblica quell'evento; la scheda per chi non vede
  la task (codice senza titolo); una task eliminata; il negativo di
  `canEditEvents`.
- **F4.3 — Allegati**: upload, legame al messaggio, download firmato per chi
  legge, modifica ed eliminazione, la ricerca (`withAttachments` e i nomi).
  Test: il negativo su un privato e su un DM altrui (download 404); il tetto e
  i tipi; un allegato di un altro, o di un altro canale, non si lega; un
  eliminato non ha allegati; la potatura.
- **F4.4 — Chiusura**: deploy-log (0141 e i trigger; il rollback: i messaggi
  `system` restano, ma un server della fetta 3 li mostra vuoti, quindi o si
  cancellano o si accetta), invariante della Chat, registro, parità server,
  righe di CLAUDE.md per l'orchestratrice.
- Nessun golden: niente di questa fetta passa dal modello.

## Global Constraints

- Chi vede e chi legge resta `chat/access.ts`. Un allegato si scarica solo da
  chi LEGGE il canale, mai da chi gestisce un privato senza esserne membro (D2).
- Il titolo nella scheda di un evento segue le regole delle task e delle
  richieste: un titolo che chi legge non vede non esce.
- Gli eventi non avvisano nessuno (nessun `notification_kind` nuovo).
- Verso i client solo cambi additivi.
- Test filtrati, mutazioni sui test passati al primo colpo, Docker coordinato
  con 94.

## Review Focus

- I trigger: una scrittura di massa (un bulk di 200 task chiuse) non deve
  diventare 200 messaggi lenti dentro la transazione di chi scrive. Va
  misurato, e se serve si raccoglie per transazione.
- Lo storage: un allegato di un messaggio eliminato non deve restare
  scaricabile con un URL firmato già dato. La firma ha una scadenza breve, e
  la riga sparisce.
