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
