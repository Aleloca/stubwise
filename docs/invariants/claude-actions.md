# Azioni di Claude (Chat con Claude, aree 9 e 10)

Le regole del catalogo delle azioni di Claude e della conversazione libera
che non stanno in un'area sola. Il catalogo è
`apps/server/src/claude-actions/` (`SERVER_CATALOG`), le firme
`packages/shared/src/schemas/claude-actions.ts`. Il design è
`docs/plans/2026-11-19-integrazione-area10-design.md`.

## Gli eventi strutturati li scrive il SERVER, non il modello (area 10, 19 nov 2026)

- `aside` (il lavoro fermo, S2), `capabilities` (S0) e `question` (le
  domande a scelta) portano solo id e chiavi.
- Le frasi le scrive il renderer dall'i18n.
- Le righe si rifiltrano a lettura con la visibilità di chi guarda: in una
  conversazione pubblica un lettore non vede la riga di un progetto che non
  vede.
- Il modello sceglie QUANDO chiamare il tool, mai COSA dice la riga.
- **Un tipo di evento nuovo vuole tre cose insieme**:
  - la riscrittura del CHECK `agent_session_events_type_chk` (0131), con una
    migrazione;
  - il valore nello `z.enum` `agentSessionEventTypeSchema`, letto dai client
    con `readerSchema`, che porta un tipo ignoto a `UNKNOWN`;
  - un test che parsa una sessione con un tipo ignoto.
- Un CHECK più stretto non è sicuro in discesa finché esistono eventi coi
  tipi nuovi.
- `capabilities` è l'elenco dell'AUTORE (dai suoi permessi): in una pubblica
  il lettore lo vede così com'è. Dice cosa Claude sa fare per l'autore, non
  un dato di progetto, ed è accettato (review di F3–F8, M9).

## Il contenuto dei tool non arriva a chi non è l'autore (review di F3–F8, I2)

- Per OGNI tool, in una conversazione con Claude (una riga in
  `claude_conversations`), chi legge e non ne è l'autore — il lettore di una
  pubblica — riceve i `tool_use` e i `tool_result` SENZA contenuto: il nome
  del tool e l'esito, `input: {}`, `content: ""`, `withheld: true`
  (`listAgentSessionEvents`, `toolEventForReader`).
- Il motivo: quel contenuto è la risposta del server all'AUTORE, coi suoi
  permessi (codici e `projectId` di ogni progetto che lui vede). Un filtro per
  chi guarda su un evento strutturato (`aside`) non serve a niente se il JSON
  grezzo arriva accanto.
- Chi aggiunge un tool non ha niente da fare qui: la regola vale per tutti. Chi
  aggiunge un evento strutturato lo filtra a lettura (sopra).
- Le letture a ELENCO che portano dati di progetto per progetto (task ferme,
  polso, seguiti, candidati all'archivio) registrano TUTTI i progetti che
  restituiscono (`recordChatToolReadProjects`), così l'autore li conferma
  alla pubblicazione: la risposta di Claude li può citare.

## Una bozza in un campo non si salva da sola (area 10, F6)

- `fillField` non scrive sul server: la conferma la segna eseguita senza
  effetti.
- Il renderer mette il testo nel campo solo se la pagina del bersaglio è
  aperta in quella finestra, col segno «Bozza di Claude».
- Il salvataggio resta della persona, dal bottone della pagina.
- È una `fn` del catalogo e non un ramo di `pageAction`: `pageAction` è
  un'unione discriminata chiusa, e un ramo nuovo farebbe fallire a un client
  vecchio il parse della proposta INTERA.

## Le funzioni del catalogo stanno nei servizi, mai nelle rotte (area 9, F7)

- Le rotte importano storage, rete e Chat.
  `claude-actions-effects.test.ts` fallisce se un modulo raggiungibile dal
  catalogo esce da solo.
- Va lanciato in ogni task che tocca il catalogo o un modulo che il catalogo
  importa.

## Il contenuto PERSONALE solo in una conversazione libera privata (area 10, F1, review)

- Posta e calendario di chi chiede, un canale privato o un DM, un'automazione
  generale, e (review di F3–F8, I1) la spesa del mese (`/api/ai-usage/summary`:
  totale e costi per progetto coi permessi di chi chiede): il token del turno li legge SOLO in una conversazione libera
  (`agent_sessions.kind = 'free'`) PRIVATA. Altrove il server risponde 403
  `chat_tool_private_only` (`isPrivateChatToolRead`, `isPrivateConversation`
  in `apps/server/src/auth/chat-tool-routes.ts`).
- Non basta la visibilità: un turno di @Claude nella Chat ha anche lui una
  riga in `claude_conversations`, privata di default, ma la sua risposta sta in
  un canale (ospiti compresi). Conta il TIPO della sessione.
- Una lettura riuscita segna la conversazione (`private_read_at`, 0197), e da
  lì non si pubblica più (409 `private_content`): `mailbox_owner` non include
  MAI gli admin, e una pubblica la legge chi ha `claude.public.view`. Si
  rifiuta tutta, non si tagliano gli eventi: la risposta di Claude li
  riassumerebbe comunque.
- Nei turni di @Claude i tool della posta, del calendario e della spesa non
  ci sono (`CHAT_PRIVATE_READ_TOOLS` fuori da `CHAT_MENTION_TOOL_NAMES`), e il
  ponte li rifiuta comunque.
- Ogni lettura per codice o per id registra il suo progetto
  (`recordChatToolReadProjects`): è ciò che trattiene il seguito di una
  pubblica finché l'autore non lo conferma. Un tool nuovo che legge un oggetto
  di progetto lo aggiunge lì.

## Le domande a scelta di Claude nella conversazione libera (area 10, F2)

- Le scrive il worker (`askConversationQuestion`): UNA per turno, sull'input
  che lo apre, con l'evento `question` (solo l'id).
- Le legge `GET /api/claude/conversations/:id/questions`: chi legge una
  pubblica vede solo quelle prima del seguito privato (`event_id`, come le
  proposte).
- Risponde SOLO l'autore, e solo finché il turno della domanda è l'ultimo
  (409 `stale` se ha già scritto altro).
- La risposta entra come un suo messaggio, nella STESSA transazione che segna
  la domanda, con il testo «<domanda>» → <scelta> (`answerText`). Il modello
  non legge gli eventi `question`: senza la domanda nel testo, una risposta
  «Supporto» non direbbe a cosa risponde. È anche il segno che quel messaggio
  risponde a una domanda.

## Le voci della doc di prodotto (area 11, F6, Task 4, 22 nov 2026)

- Sei voci, tutte B (F6-1 = a): `writeFirstVersion`, `updateProductPage` e
  `drawWireframe` fanno partire il modello (`starts_work`); `undoFirstVersion`,
  `undoProductUpdate` e `deleteWireframe` sono gli inversi (P39). Il permesso è
  `docs.edit` nel progetto, lo stesso delle rotte
  (`claude-actions/catalog-product.ts`).
- «Aggiorna <pagina> da questa email» è un lavoro della coda della doc con
  `source_kind = 'page_update'` e `source_id` = la riga di
  `product_page_updates` (0217): UNA fonte, UNA pagina, chi l'ha chiesto. La
  fonte deve essere sua da APRIRE (`canOpen`, `mailbox_owner`) e del progetto;
  la sezione presa da lui non lo fa aspettare (`requesterId` di
  `writeClaudeFacts`); la pausa della coda no, il budget sì. Da qui non si
  annulla: la revisione arriva dopo, dal worker, e si annulla con
  `undoProductUpdate` o dalla cronologia. Il worker RICONTROLLA chi ha chiesto
  a ogni partenza del lavoro (`docs.edit` nel progetto e la fonte sua da
  aprire): un lavoro fermo può ripartire dopo ore, e la revoca vale a lettura.
  Se manca, il lavoro si chiude con `requester_no_permission`,
  `requester_cannot_open_source` o `requester_gone`, senza modello.
- Le letture `read_product_page` e `read_product_changes` sono contenuto NON
  fidato (`CHAT_TOOL_UNTRUSTED_ROUTES`) e registrano i loro progetti.
- Col token di una chat `GET /api/product-changes` non manda MAI l'oggetto né
  il thread di una fonte `email` o `meeting`, nemmeno al titolare: restano
  tipo, titolare e `canOpen`. La lettura non è privata (vale anche in una
  pubblica e nei turni di @Claude nei canali, ospiti compresi), quindi la
  posta non ci entra; il ponte scarta comunque quei titoli da
  `sourceTitles`. La rotta letta dal desktop resta com'è.
- Limite accettato: la capacità `productBacklog` si accende con
  `backlog.create` in un progetto qualunque, ma il flusso «Turn into backlog
  items» chiede anche `docs.view` nel progetto della pagina. Chi ha il primo
  senza il secondo vede la capacità e riceve un rifiuto alla proposta.
- La pulizia delle immagini della doc sta in `services/product-images-purge.ts`
  e NON in `product-docs-ops.ts`: quel modulo lo raggiunge il catalogo, e lo
  storage da lì è un'uscita (`claude-actions-effects.test.ts`).
