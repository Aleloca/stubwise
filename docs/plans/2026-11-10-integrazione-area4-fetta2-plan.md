# Integrazione area 4 — Chat, fetta 2 — piano (10 nov 2026)

> Autore: stubwise-72 (server), renderer a stubwise-94. Branch del server:
> `feat/area4-f2-server`, da `origin/feat/integrazione-area4`. Design e
> decisioni D1–D9: `docs/plans/2026-11-10-integrazione-area4-chat-design.md`;
> fetta 1: `docs/plans/2026-11-10-integrazione-area4-fetta1-plan.md`;
> invariante: `docs/invariants/chat.md`. Specifica: il prototipo
> (`apps/desktop/src/renderer/data/chat/{visibility,writes,reads,mentions}.ts`).

## Perimetro (dall'orchestratrice, 10 nov 2026, e dal registro)

1. **DM** da 2 a 8 persone, compresa chi lo apre. Se c'è già un DM con le stesse persone si riapre quello (`openDm`). Esiste solo per chi partecipa, **nemmeno il full admin** lo vede (D2). Un DM a due non si lascia; un gruppo sì. Nessuno invita né toglie.
2. **Canali privati**, di progetto e generali:
   - nascono con chi li crea e le persone invitate;
   - li **vedono** i membri e chi gestisce quell'ambito: nome e membri, ma **non** argomento, descrizione e messaggi (D2);
   - **invitano** il creatore o chi gestisce, mai sé stessi;
   - **tolgono** il creatore o chi gestisce;
   - non restano senza membri (`last_member`);
   - in un canale di progetto entrano solo persone che vedono il progetto.
3. **Canali generali d'istanza** (`kind general`, senza progetto), aperti o privati:
   - li crea chi ha `chat.general.create`;
   - li gestisce chi ha `chat.general.manage`, oppure il creatore;
   - un aperto lo vedono tutti, e ci si entra con «Join»;
   - il nome è unico fra i generali.
4. **Ricerca** (`searchChat`):
   - solo nei canali che chi guarda LEGGE: mai un privato di cui non è membro, nemmeno se lo gestisce, e mai un DM altrui. Gli archiviati sono compresi, gli eliminati mai;
   - ogni parola (da 2 caratteri in su) deve comparire, senza maiuscole né accenti, nel testo o nei codici delle task e richieste nate dal messaggio;
   - filtri: canale, autore, «solo persone» e un intervallo di date. I filtri «con allegati» e «con citazioni» seguono le loro fette (vedi [DECIDE] 1);
   - risultati dal più recente.
5. **Domande** (`asksReplyOf`):
   - un messaggio che nomina qualcuno e finisce con «?», o con «Ask for a reply» forzato, chiede una risposta alle persone nominate (mai a chi scrive);
   - a un **membro** arriva una card `chat.question` (`notification_kind` nuovo, con push); a chi legge senza essere membro, una `chat.mention`;
   - la domanda compare in «Da decidere» (`listQuestions`) finché la persona non risponde (nel thread, o nel canale per un messaggio del canale) o non la ignora (`dismissQuestion`);
   - non compare in un canale archiviato, e un messaggio eliminato non chiede più niente;
   - una modifica tiene chi è ancora nominato e aggiunge i nuovi.
6. **«Create task» e «Create request» da un messaggio**:
   - la creazione è quella di sempre, con i suoi permessi;
   - il messaggio mostra «→ AUD-14» (`linkedCodes`), con il codice derivato a lettura e filtrato per chi guarda;
   - un messaggio eliminato non annuncia più niente, ma la task resta.
7. **`alsoInChannel`**: una risposta mandata «anche nel canale» entra nel flusso del canale, nei suoi non letti e nella lettura del canale.

### Allineamenti della fetta 1 al prototipo

Li ho trovati confrontando il codice. Non sono decisioni nuove: la fetta 1 si era fermata prima.

- **Permessi del canale**:
  - il creatore modifica nome e descrizione, archivia e invita; argomento lo cambia qualunque membro; eliminare resta solo a chi gestisce l'ambito (`managesChannel` / `managesScope`, R-G3);
  - la vista riceve i campi del prototipo: `canRead`, `canEditInfo`, `canEditTopic`, `canEditEvents`, `canInvite`, `canRemove`, `canArchive`, `canDelete`, tutti con default;
  - `canManage` resta, per i client della fetta 1, come «almeno una delle azioni di gestione».
- **Conteggi per livello di notifica** (`countsOf`):
  - `unread` dipende dal livello: `all` conta tutto, `mentions` solo ciò che è diretto, `muted` niente;
  - `mentions` conta anche `@channel` e `@<reparto>` con il livello `all`: i reparti esistono sul server (`departments`). Restano senza card né push (R-G6);
  - in un DM ogni messaggio di una persona è rivolto a chi partecipa.
- **Un eliminato senza risposte sparisce dopo un giorno** (`isGone`): è un filtro a lettura, nessuna potatura.

### Fuori dalla fetta 2

- @Claude e le sue domande in «Da decidere»: fetta 3.
- Eventi dei progetti nei canali e allegati: fetta 4.
- Le citazioni, salvo [DECIDE] 1.

## Decisioni

1. **DECISO (a) dal maintainer (M), 10 nov 2026.** **Le citazioni nei messaggi** (`citations`, il «punto di forza» del design del prototipo). In D1 non hanno una fetta: nella fetta 1 il renderer manda `citations: []`.
   - **(a, consigliata)** Fetta 2, per gli oggetti che il server ha già:
     - task, richieste e progetti, sia scelti con «#» sia scritti come codice («AUD-88», che diventa link da sé);
     - persone;
     - pagine Docs.

     Il server tiene solo le scelte che chi scrive vede e che il testo nomina ancora, e le ricalcola alla modifica (`citationsOf` / `canCite` / `stillNamed`). A lettura le filtra per chi guarda. Traguardi, Release, brief, file del repo e Drive restano nelle fette 4 e 5, con gli eventi e l'area Drive. Con questa scelta anche la ricerca trova un messaggio per i codici citati, e il filtro «con citazioni» si accende.
   - (b) Tutte nella fetta 4, con gli eventi: i messaggi restano testo semplice e i codici scritti a mano non diventano link.
   - (c) Solo i codici scritti a mano diventano link nella fetta 2; le scelte con «#» vanno nella fetta 4.

## Il modello (tecnico, mie scelte)

Migrazioni **0137** e **0138**, il primo numero libero sui branch remoti.

- **0137**:
  - `chat_channels.dm_key`: gli id dei membri ordinati, per ritrovare un DM; indice non unico, e la creazione si serializza con `pg_advisory_xact_lock`. Un gruppo da cui qualcuno è uscito può coincidere con un DM già esistente: `openDm` riapre il più vecchio, come `find` del prototipo;
  - indice unico `(name) WHERE kind = 'general'`;
  - `chat_messages.also_in_channel`;
  - `chat_messages.search_folded`: testo senza maiuscole né accenti, scritto dal server a ogni scrittura;
  - `CREATE EXTENSION IF NOT EXISTS pg_trgm` (estensione *trusted* da PG13, la crea il proprietario del DB) con un indice GIN trigram su `search_folded`;
  - `chat_dismissed_questions (user_id, message_id)`;
  - `chat_message_links (message_id, ticket_id | backlog_item_id)`, in cascata sul messaggio e sull'oggetto (una task eliminata non è più annunciata);
  - per le citazioni (F2.7) la tabella va nella **0139**: `chat_message_citations (message_id, kind, ref_id, position)`.
- **0138**: `ALTER TYPE notification_kind ADD VALUE 'chat.question'`, in uno statement a sé (la trappola dell'enum nella stessa transazione).
- **Permessi**: nessuno nuovo, perché `chat.general.*` c'è dalla 0135. La regola dei preset non serve, ma la riverifico.
- **Ricerca**: substring per parola su `search_folded` (`ILIKE` sui termini già normalizzati, con l'indice trigram), più i codici delle task nate dal messaggio. Non uso `to_tsvector('english')` come i ticket: lo stemming inglese su testo italiano cambia i risultati, e il prototipo, che è la specifica, cerca sottostringhe.
- **Create task**:
  - `POST /api/tasks` riceve `chatMessageId`, opzionale e additivo. Il server verifica che il messaggio si legga e non sia eliminato, poi scrive il legame nella STESSA transazione della task: un solo percorso di creazione, con i suoi permessi;
- **Create request**:
  - stesso campo su `POST /api/requests`;
  - il legame lo scrive il **worker** a fine intake, anche quando l'intake fonde la richiesta in una esistente (il prototipo lega il codice che riceve);
  - il campo viaggia nel payload del job di intake.
- **Visibilità**: `access.ts` resta l'unico posto, con `channelVisibleSql` (vedere) e `channelReadableSql` (leggere). La ricerca, le domande, le menzioni e le card passano da `channelReadableSql`.
- **Chi può stare in un canale aperto generale e in un DM**: le persone, cioè gli utenti non agenti.

## Task

- **F2.1 — DB e schemi shared**:
  - 0137, 0138 e `schema.ts`;
  - in `packages/shared/src/schemas/chat.ts`, i campi nuovi della vista canale e del messaggio, tutti con default;
  - i body: crea generale o privato, `invite`, `remove`, `openDm`, `asksReply`, `alsoInChannel`, `chatMessageId` su task e richieste;
  - le risposte di `questions` e `search`;
  - il kind nel notification schema, con `chat` derivato anche per `chat.question`;
  - test: load-isolated, api-client (il guardiano), `roles-migration`, uno di migrazione sui dati esistenti (un DM ha `dm_key`, un messaggio vecchio ha `search_folded`).
- **F2.2 — Canali**:
  - `access.ts` con privati, generali e DM, e i permessi del prototipo;
  - `createChannel` generale o privato con gli invitati;
  - `inviteMembers`, `removeMember`, `openDm`, `leave` (un DM a due no, un privato non resta vuoto);
  - `updateChannel` col creatore e l'argomento;
  - test: il negativo su DM e full admin (404, e la lista non lo contiene), «chi gestisce vede il privato ma non i messaggi né l'argomento», l'invito di sé stessi rifiutato, il membro fuori dal progetto rifiutato.
- **F2.3 — Messaggi**:
  - `alsoInChannel`, i conteggi per livello, `@channel` e `@reparto`, i DM, `isGone`;
  - domande: card `chat.question` contro `chat.mention`, `GET /api/chat/questions`, `POST /api/chat/questions/:messageId/dismiss`, risposta che la chiude, modifica;
  - test con mutazioni.
- **F2.4 — Ricerca**: `GET /api/chat/search?q=&channelId=&authorId=&peopleOnly=&from=&to=`. Test: il negativo su privati e DM altrui, gli accenti, le parole multiple, gli eliminati, gli archiviati.
- **F2.5 — Da un messaggio**:
  - `chatMessageId` su task e richieste, il worker che lega a fine intake, `linkedCodes` derivati e filtrati;
  - test: task, richiesta fusa, task eliminata, messaggio eliminato, codice invisibile a chi guarda.
- **F2.6 — Card, mobile e chiusura**:
  - la card `chat.question` nell'inbox (derivata) e nel mobile (`InfoCard`, i18n, fixture complete);
  - deploy-log 0137–0138, con ⚠️ `chat.question` nel rollback;
  - l'invariante aggiornata, il registro, la parità server e le righe di CLAUDE.md per l'orchestratrice.
- **F2.7 — Citazioni** (decisione 1 (a), M):
  - `citationsOf` sul server (migrazione 0139, `chat_message_citations`), filtrate a lettura su ciò che chi legge vede;
  - i codici citati entrano nella ricerca, e si accende il filtro «con citazioni»;
  - traguardi, Release, brief, file del repo e Drive restano alle fette 4 e 5.

## Global Constraints

- Chi vede e chi legge stanno in UN posto (`access.ts`), nella WHERE. Un canale non visibile risponde 404 e un DM altrui non esiste. Ogni rotta nuova dichiara `config.access`.
- Il client legge i permessi calcolati dal server e non li deduce.
- Verso i client solo cambi additivi: campi nuovi con default, e `chat.question` dietro `readerSchema`. Sul web, `?? default` nel punto di lettura.
- Il registro decisioni non si scrive mai (le domande della Chat non sono decisioni del progetto).
- I test girano sempre filtrati, mai la suite intera. Docker si coordina con stubwise-94. Un test che passa al primo colpo si verifica con una mutazione, e prima di una mutazione cross-package si ribuilda il `dist`.

## Review Focus

- DM e privati: un full admin, chi gestisce l'ambito e chi è uscito dal progetto non leggono, in nessuna rotta (lista, messaggio, thread, stream, ricerca, menzioni, domande, card).
- Il legame task/richiesta non rivela un codice a chi non vede la task.
- `dm_key` con le uscite, e la concorrenza di due `openDm` uguali.
