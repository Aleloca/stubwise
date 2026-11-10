# Chat fra persone (area 4)

Design: `docs/plans/2026-11-10-integrazione-area4-chat-design.md`. Fetta 1
(10 nov 2026): solo i canali di PROGETTO aperti, cioè il «general» e quelli
creati. Il codice sta in `apps/server/src/chat/`; le rotte in
`apps/server/src/routes/chat.ts`, sotto `/api/chat`.

## Chi vede, chi scrive, chi gestisce: UN posto

`apps/server/src/chat/access.ts` è l'unico posto della regola. Lista, lettura,
stream, menzioni e card d'inbox passano tutti da lì:

- **vede** un canale chi vede il suo progetto (`visibleProjectIds`). Un canale
  che non si vede risponde **404**, come uno che non esiste;
- **scrive** un membro, se il canale non è archiviato. Del «general» sono
  membri tutti quelli che vedono il progetto: è un dato **derivato**, mai
  copiato in `chat_channel_members`, così chi entra nel progetto ci scrive
  subito e chi ne esce smette subito;
- **gestisce** (rinomina, archivia, elimina) chi ha `chat.channels.manage` nel
  progetto. Il «general» non lo gestisce nessuno (409 `general_channel`).

Il client legge `canWrite`, `canJoin`, `canLeave` e `canManage` calcolati dal
server, e non li deduce.

## Il «general» nasce col progetto, da un trigger

Il trigger `projects_chat_general` (`AFTER INSERT ON projects`, 0135) crea il
«general» nella STESSA transazione che crea il progetto. Copre così ogni punto
che inserisce un progetto (la rotta, gli script, i seed dei test), non solo la
rotta. L'indice unico parziale `chat_channels_one_general_idx` ne garantisce
uno solo per progetto, e la funzione usa `ON CONFLICT DO NOTHING`.

Il costo è stato misurato il 10 nov 2026: circa 0,25 ms per progetto (1000
inserimenti, 1898 ms col trigger e 1644 senza). I test che creano progetti in
serie non ne risentono.

Eliminare un progetto porta via i suoi canali in cascata, e con loro messaggi,
reazioni, letture, preferenze e follow. Una card di menzione resta, senza
link (vedi sotto). Lo verifica il test «eliminare il progetto» di
`routes/chat.test.ts`.

## Un messaggio eliminato non ha più testo

Eliminare scrive `body = ''`, ed è garantito da un CHECK (`deleted_at IS NULL
OR body = ''`). È la stessa regola dei commenti dei ticket: ogni lettore di
`body` smette da solo di vederlo. Si modificano e si eliminano solo i propri
messaggi (403 `not_yours`).

## Le menzioni le decide il server

- I `mentionedIds` li deriva il server dal testo. Un `@Nome` vale solo se
  `Nome` è il `personName` di qualcuno che LEGGE il canale. Chi scrive è
  escluso. Il client non li manda.
- `@channel` e `@reparto` non avvisano nessuno (R-G6, fetta 1).
- Una card `chat.mention` per persona nominata, con push, nella STESSA
  transazione del messaggio. Una modifica avvisa solo chi viene nominato per la
  PRIMA volta: chi era già nominato non riceve una seconda card.
- Chi viene nominato in un thread comincia a seguirlo (`chat_thread_follows`).

## La card d'inbox si DERIVA a lettura

Nel jsonb della notifica ci sono solo gli id (`chatMessageId`, `channelId`) e
il testo vero al momento della publish (`channelName`, `authorName`). Il blocco
`chat` della card (canale, messaggio, radice del thread, autore, estratto) e
l'url `/app/#/chat/…` li ricostruisce `chatMentionsFor`
(`apps/server/src/chat/service.ts`) a ogni lettura. Lo fa con la stessa regola
di visibilità, e con una query per pagina, non una per card.

Se il messaggio è eliminato, il canale non si vede più o il progetto non c'è
più, `chat` è `null`, `objectGone` è `true` e la card non ha url. È
l'invariante trasversale «i campi che un client legge su una card si derivano
a lettura» (CLAUDE.md).

## Lo stream: cursore intero in microsecondi

`GET /api/chat/channels/:id/stream?after=<cursore>` è un SSE che rilegge
visibilità e utente a ogni giro. Il cursore è `updated_at` in **microsecondi
interi**, come testo di sole cifre (`CHAT_STREAM_CURSOR_RE`), e il confronto si
fa in SQL. Un `Date` di JS tronca ai millisecondi, e due messaggi nello stesso
millisecondo si perderebbero. Ogni scrittura su un messaggio (modifica,
eliminazione, reazione) aggiorna il suo `updated_at`, e una risposta aggiorna
anche quello della radice, il cui conteggio cambia. Il bus (`chat/bus.ts`) usa LISTEN/NOTIFY sul canale Postgres
`chat_channel` e serve solo a svegliare lo stream prima del poll di 5 secondi:
se manca, lo stream resta corretto, solo più lento.

## Limiti della fetta 1, nel registro

Restano fuori: canali privati e DM, `alsoInChannel`, la ricerca, i messaggi
«via Claude» (`via_claude_action_id` c'è, ma vuoto), le domande in chat,
«Create task/request» da un messaggio e @Claude. Sono elencati in
`docs/plans/integrazione-registro-rimandi.md`, area 4.
