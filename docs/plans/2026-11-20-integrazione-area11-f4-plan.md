# Integrazione area 11, F4 — la scrittura dal vivo: piano

> Design: `docs/plans/2026-11-20-integrazione-area11-design.md`, «F4» (D-2 =
> a, maintainer). Specifica: il prototipo (`data/productDocs/presence.ts`,
> `live/*` nel renderer, `productPending` del 11b: Claude aspetta chi scrive
> nella stessa sezione). Invarianti: `agent-sessions.md` (lo stream ricalcola
> i permessi), `permissions.md` («La revoca si applica a lettura»), e quella
> nuova del design («Il canale dal vivo ricalcola i permessi a ogni evento»).
> Branch: `feat/area11-f4` da `feat/area11-f3`.

## Prima del codice

- **Nessuna [DECIDE].** Si vede ciò che il prototipo mostra col suo copione:
  gli avatar, i cursori, «X sta scrivendo qui», i blocchi degli altri senza
  ricaricare.
- **Ruling (la sezione presa sta in tabella; presenza e cursori no)**: il
  design dice «la presenza non si scrive mai in tabella». La SEZIONE PRESA
  però la deve vedere anche il worker (F5: Claude aspetta chi scrive nella
  stessa sezione, e scrive dal worker), che non vede la memoria del server.
  Quindi:
  - presenza e cursori: in memoria del processo server, con scadenza, mai in
    tabella (come dice il design);
  - la sezione presa: `product_section_holds (page_id, section_id, user_id,
    expires_at)`, rinnovata dal battito di chi scrive, scaduta da sola.
  L'invariante del design va letta così, e la riscrivo nel documento delle
  invarianti quando 46 la applica. Se sbagliato costa una tabella.
- **Ruling (cos'è una sezione)**: un titolo e i blocchi fino al titolo dello
  stesso livello o più alto dopo di lui; i blocchi prima del primo titolo
  sono la sezione «in cima». La regola sta in shared (`sectionOf(blocks,
  blockId)`), la stessa per server, worker e client. È quella del prototipo.
- **Fatti del codice che contano**:
  - lo stream delle sessioni (`GET /api/agent-sessions/:id/stream`,
    `routes/agent-sessions.ts`) è il modello: hijack della risposta, `text/
    event-stream`, una pagina di eventi a ogni giro, una rete di sicurezza a
    tempo se una NOTIFY si perde, i permessi riletti con una validità breve;
  - `agent-session-bus.ts`: UNA `LISTEN` per canale per processo, condivisa
    da tutti gli stream. Il canale della doc (`product_page_events`) ne usa
    una sua, accanto;
  - un solo processo server oggi (nessun bilanciamento dietro caddy): la
    presenza in memoria regge; la voce di deploy lo dice.

## Regole di lavoro (le solite)

Come F1. Nel giro anche i test dello stream delle sessioni (il bus condiviso).

## Task 1 — la sezione e le prese (shared, db)

- `sectionOf` in shared, coi casi del prototipo (titoli annidati, la sezione
  in cima, un titolo tolto).
- La tabella `product_section_holds` (pk `(page_id, section_id)`, `user_id`,
  `expires_at`), e `takeSection(db, pageId, sectionId, userId, ttl)`:
  prende se libera o scaduta o già sua, altrimenti dice chi la tiene.

**Test**: due persone sulla stessa sezione, la seconda no; la presa scade da
sola; la presa si rinnova; sezioni diverse sì.

Mutazione: ignorare `expires_at`.

## Task 2 — le operazioni rispettano la presa (server)

- `POST …/ops` (F1) rifiuta con 409 `section_busy { by, sectionId }` le
  operazioni su blocchi di una sezione presa da un ALTRO; chi scrive prende
  la sezione dei blocchi che tocca (la stessa transazione del `FOR UPDATE`).
- Un `move` fra due sezioni le chiede entrambe.

**Test**: la scrittura dell'altro rifiutata, la sua passa; dopo la scadenza
passa; un `move` verso una sezione presa rifiutato; nessuna operazione
applicata a metà (409 = niente cambiato).

Mutazione: prendere la sezione DOPO aver applicato le operazioni.

## Task 3 — il canale (server)

- `GET /api/product-pages/:id/live` (SSE, `docs.view`): all'apertura lo
  stato (chi c'è, le prese, l'ultimo `seq`); poi gli eventi `revision`
  (con le operazioni, per applicarle senza ricaricare), `presence`,
  `cursor`, `hold`, `release`. I permessi si rileggono a ogni evento (con una
  validità di pochi secondi, come lo stream delle sessioni): un accesso tolto
  chiude lo stream.
- `POST /api/product-pages/:id/live/presence { cursor?: { blockId, offset },
  sectionId? }` (`docs.view`; con `sectionId` serve `docs.edit` e rinnova la
  presa): un battito ogni 5 s, scadenza 15 s.
- La revisione nuova (F1) manda un `pg_notify` su `product_page_events` dopo
  il commit; il bus la consegna agli stream di quella pagina.
- Tetti: 50 stream per pagina, 10 per persona.

**Test** (`product-live.test.ts`): due lettori, un salvataggio, l'altro
riceve la revisione; un accesso revocato chiude lo stream; il battito di un
lettore senza `docs.edit` con `sectionId` 403; la presenza sparisce dopo la
scadenza; nessun nome di una persona che chi guarda non vede (R-G5).

Mutazione: i permessi letti solo all'apertura.

## Task 4 — api-client e documenti

- `api-client`: il battito; lo stream resta del renderer (`EventSource` sul
  web, il main del desktop come per lo stream delle sessioni).
- `deploy-log.md`: una migrazione (una tabella), nessuna env. ORDINE: server,
  poi caddy. Rollback: sicuro (un server vecchio non manda gli eventi; il
  renderer torna a «Saved» con il 409 `stale` di F1). ⚠️ Più processi server
  dietro caddy rompono la presenza in memoria: oggi non ci sono, e la voce lo
  scrive.

## Per 94 (renderer)

- Gli avatar, i cursori, «X sta scrivendo qui» al posto del copione
  (`data/seed/productDocs/presence.ts`).
- Il 409 `section_busy`: il blocco resta com'era e la sezione mostra chi la
  tiene.
- `sectionOf` sta in shared: il prototipo la importa.

## Review Focus

- I permessi a ogni evento, non all'apertura.
- Una sezione presa da un altro non si scrive, e il 409 non lascia niente a
  metà.
- La presa è visibile al worker (F5).
- Nessun nome di chi chiede non vede.
