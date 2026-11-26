# Integrazione area 4 — Chat (canali fra persone) — design (10 nov 2026)

> Stato: **DECISO il 10 nov 2026**: (M) = il maintainer, (O) =
> l'orchestratrice. D1 (a) (O), D2 (a) (M), D3 (a) (M), D4 (a) (M), D5 (a)
> (M), D6 (a) (M), D7 (a) (M), D8 (a) (O), D9 (a) (M), cioè tutte le
> consigliate. Piano della fetta 1:
> `docs/plans/2026-11-10-integrazione-area4-fetta1-plan.md`. Branch
> d'integrazione: `feat/integrazione-area4`. Le opzioni scartate restano qui
> sotto. Autore: stubwise-72.

**Specifica**: il prototipo.
- Design: `docs/plans/2026-10-25-desktop-area4-chat-design.md`, con le
  decisioni del maintainer già prese lì.
- Parità: `apps/desktop/docs/area4-parity.md`.
- Shape: `apps/desktop/.impeccable/shape/chat{,-thread,-search,-manage}.md`.
- Codice: `apps/desktop/src/renderer/data/chat/*` (circa 53 funzioni) e
  `pages/chat/**` (circa 16 superfici).

**Registro**: «Area 4 — Chat» (`docs/plans/integrazione-registro-rimandi.md`).

**Base**: la chat con Claude (fette 1–5), da cui si riusano:
- il turno di Claude;
- il token del turno;
- le proposte;
- lo stream SSE.

## Dove siamo

- **Il server non ha niente di chat fra persone.** Mancano:
  - le tabelle (canali, membri, messaggi, reazioni, letture, preferenze);
  - le rotte;
  - le menzioni (nessun `notification_kind` `chat.*`);
  - lo stream;
  - i 4 permessi, che esistono solo nel prototipo come permessi «locali».
- La web app vecchia non ha una chat. Nella build app la destinazione Chat è
  spenta (`data/integration.ts`), e `api.chat` è «non integrato».
- **Da riusare**:
  - i commenti dei ticket: risposta a un livello, modifica, eliminazione
    che svuota il testo (con CHECK), segno «via Claude»;
  - gli allegati e lo storage;
  - `publishNotification`, l'inbox e la consegna `push`;
  - il bus LISTEN/NOTIFY e lo stream SSE delle sessioni, anche via
    `openStream` del main del desktop;
  - per @Claude: il runner della chat, il token del turno, il ponte MCP,
    `propose_action` e le proposte.

## Decisioni già prese (dal design del prototipo, non si riaprono)

- **I tipi di canale**: canali di progetto, canali generali, DM da 2 a 8
  persone. Un thread ha un solo livello. Si possono reagire, modificare ed
  eliminare i propri messaggi. Le citazioni sono il «punto di forza».
- **Menzioni**:
  - avvisano solo `@Nome` diretta e una domanda rivolta alla persona, e solo
    se lei legge il canale;
  - `@channel` e `@reparto` non avvisano mai (R-G6);
  - chi viene nominato in un thread inizia a seguirlo.
- **@Claude** *(maintainer)*:
  - ogni «@Claude» è una chiamata di chi la scrive, con i **suoi permessi,
    senza altri controlli**;
  - Claude pubblica subito, nel thread, «Claude, chiamato da X», e chi lo
    chiama ne è responsabile;
  - le modifiche sono SEMPRE proposte (niente classe A, niente «Annulla»), e
    le conferma solo chi l'ha chiamato;
  - le proposte scadono dopo 20 messaggi del thread o 24 h;
  - il contesto è il thread, filtrato per chi chiama.
- **Gli eventi dei progetti nel canale** *(maintainer)*: messaggi di sistema
  nel «general», o in un canale scelto, con la scheda dell'oggetto.
- **Slack si spegne nell'app desktop** *(maintainer)*. Il webhook in uscita
  resta.

## Vincoli (proposti)

1. **Chi vede lo decide il SERVER, nella WHERE, in UN posto** (la regola di
   `visibility.ts` del prototipo):
   - un canale aperto di progetto lo vede chi vede il progetto;
   - un aperto generale lo vedono tutti;
   - un privato lo vedono i suoi membri;
   - un DM esiste solo per chi partecipa.

   Un canale che non si vede è 404, come uno che non esiste. Il client legge
   i permessi calcolati, non li deduce.
2. **Un messaggio eliminato non ha più testo**, come i commenti: CHECK
   `deleted_at IS NULL OR body = ''`.
3. **Le menzioni si derivano dal testo sul server**, alla scrittura. Il
   client non manda l'elenco degli avvisati.
4. **@Claude passa da proposte, mai esecuzioni dirette**, con la regola delle
   fette 3–5:
   - il token del turno è di chi chiama;
   - la classe sale sempre a B (niente A in chat);
   - conferma solo chi ha chiamato;
   - il registro decisioni non si scrive mai.
5. **Verso i client solo cambi additivi**: kind nuovi dietro `readerSchema`,
   campi con default.

## Decisioni (prese il 10 nov 2026)

- **D1 — deciso (a) (O)**: l'ordine delle fette.**
  - **(a, consigliata)** Quattro fette:
    1. canali di progetto e il «general», messaggi, thread, reazioni,
       modifica ed eliminazione, letti e non letti, menzioni nell'inbox,
       stream;
    2. DM, canali privati, generali, ricerca, «Da decidere» (domande della
       chat);
    3. @Claude nei canali;
    4. eventi dei progetti nei canali e allegati.

    La fetta 1 da sola è già una Chat usabile dentro i progetti.
  - (b) Tutto il modello in una fetta e @Claude dopo: una fetta molto grande
    (circa 17.000 righe del prototipo da coprire).
  - (c) I DM nella fetta 1, se servono presto.
- **D2 — deciso (a) (M)**: chi vede i privati e i DM.**
  - **(a, consigliata)** Come il prototipo. Un canale privato lo vedono i
    suoi membri; chi gestisce i canali ne vede l'esistenza (per gestirlo) ma
    **non legge i messaggi**. Un DM esiste solo per chi partecipa, **nemmeno
    il full admin** lo vede. È la stessa scelta delle conversazioni private
    con Claude.
  - (b) Il full admin legge tutto, a fini di conformità. Così però la Chat
    non è privata, e va detto nell'interfaccia.
- **D3 — deciso (a) (M)**: i permessi.** Il registro condiviso riceve
  `chat.channels.create` e `chat.channels.manage` (di progetto) e
  `chat.general.create` e `chat.general.manage` (d'istanza).
  - **(a, consigliata)** I preset del prototipo, con una migrazione:
    - `create` a Project Lead e Developer, `manage` al Project Lead;
    - `chat.general.create` al preset User, `manage` al full admin (per
      costruzione).

    Leggere e scrivere in un canale di progetto non vuole un permesso nuovo:
    basta vedere il progetto ed essere membri del canale. Per i preset, il
    Legacy Member, il Contributor e il Viewer leggono e scrivono, ma non
    creano canali.
  - (b) Nessun preset: si assegnano con un ruolo.
- **D4 — deciso (a) (M)**: le notifiche.**
  - **(a, consigliata)** Le menzioni e le domande diventano card d'inbox
    (`chat.mention`, `chat.question`, due `notification_kind` nuovi), con
    titolo e testo **derivati a lettura** (la regola delle card d'inbox) e
    **push** come le altre card. Il livello `all` di un canale incide solo
    sui non letti, come il prototipo.
  - (b) Come il prototipo, senza push.
  - (c) Anche «ogni messaggio di un canale in `all`»: è rumoroso, e il
    prototipo non lo fa.
- **D5 — deciso (a) (M)**: @Claude e ciò che legge, sul server.** La decisione del
  maintainer resta: i permessi di chi chiama, e chi chiama ne è
  responsabile. Sul server vero ne segue una cosa che il prototipo non ha:
  le letture dei tool di Claude (gli eventi `tool_use`/`tool_result`) sono
  fatte con i permessi di chi chiama.
  - **(a, consigliata)** Nel canale si pubblicano solo la **risposta** di
    Claude e le schede delle proposte, non gli eventi dei tool. Chi chiama
    li vede espandendo «cosa ha letto». È la differenza dalla fetta 5, dove
    il maintainer ha tenuto i tool visibili. Qui il canale non ha una
    conferma di pubblicazione, quindi meno resta esposto, meglio è.
  - (b) Come la fetta 5: anche gli eventi dei tool, per tutti i membri del
    canale.
- **D6 — deciso (a) (M)**: chi può eliminare i messaggi degli altri.**
  - **(a, consigliata)** Come il prototipo: solo i propri; la risposta di
    Claude la elimina chi l'ha chiamato. Un canale lo archivia o lo elimina
    chi lo gestisce.
  - (b) Anche chi gestisce il canale (moderazione), come `tickets.moderate`
    sui commenti.
- **D7 — deciso (a) (M)**: conservazione.**
  - **(a, consigliata)** I messaggi restano finché si eliminano, come i
    commenti; un canale eliminato porta via i suoi messaggi.
  - (b) Una potatura dopo N mesi.
- **D8 — deciso (a) (O)**: il «general» dei progetti che esistono già.**
  - **(a, consigliata)** Una migrazione crea il «general» di ogni progetto
    esistente (non archiviato), con gli eventi predefiniti (Release,
    traguardi, brief). Per i progetti nuovi lo crea `createProject`, nella
    stessa transazione.
  - (b) Lo crea il primo che apre la Chat del progetto.
- **D9 — deciso (a) (M)**: l'app mobile e il web vecchio.**
  - **(a, consigliata)** Fuori da questa area: la Chat è dell'app nuova
    (desktop e `/app`). Le card delle menzioni arrivano comunque nell'inbox
    dell'app mobile, che apre il messaggio in sola lettura o rimanda
    all'app.
  - (b) Anche una lettura nel mobile, come area a sé dopo.

## Il modello sul server (proposta tecnica, non da decidere)

- **Tabelle**:
  - `chat_channels`: kind `project|general|dm`, visibility `open|private`,
    `project_id`, `is_general`, archiviazione, `published_events`;
  - `chat_channel_members`: canali privati, DM e partecipazione ai canali
    aperti;
  - `chat_messages`: autore, `kind person|system|claude`, `called_by`,
    `thread_root_id`, body, `edited_at`, `deleted_at`/`deleted_by` (col
    CHECK), `via_claude_action_id`, `asks_reply_of`;
  - `chat_reactions`;
  - `chat_reads`: `last_read_at` per canale e per thread;
  - `chat_channel_prefs`: `all|mentions|muted`;
  - `chat_dismissed_questions`.
- **Visibilità**: un modulo `chat-access.ts` con la funzione SQL della WHERE.
  La usano lista, lettura, stream, ricerca e notifiche.
- **Stream**: un bus `chat` come `agent-session-bus` (LISTEN/NOTIFY), con
  SSE `GET /api/chat/channels/:id/stream`. Il main del desktop ci passa con
  `openStream`.
- **@Claude**: un turno come quello della chat (`apps/worker/src/claude-chat`),
  con kind di sessione nuovo `chat_mention` e lo stesso token del turno e
  ponte. Il contesto è il thread filtrato per chi chiama. La risposta
  diventa un messaggio `kind claude`, e le proposte passano da
  `propose_action` con la classe forzata a B.
- **Ricerca**: full-text Postgres sui messaggi visibili, come i ticket.

## Fuori da quest'area

- Chiamate, presenza e messaggi programmati: esclusi dal design del
  prototipo.
- Le regole complesse degli eventi nei canali: area 7.
- La struttura del Drive per gli allegati: area 5. La fetta 4 qui usa lo
  storage degli allegati di oggi.
