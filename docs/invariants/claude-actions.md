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
  generale: il token del turno li legge SOLO in una conversazione libera
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
- Nei turni di @Claude i due tool della posta e del calendario non ci sono
  (`CHAT_MENTION_TOOL_NAMES`), e il ponte li rifiuta comunque.
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
