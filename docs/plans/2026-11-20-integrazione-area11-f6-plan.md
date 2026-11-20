# Integrazione area 11, F6 — prima versione, wireframe, backlog, il catalogo di Claude: piano

> Design: `docs/plans/2026-11-20-integrazione-area11-design.md`, «F6» (D-10
> = a, D-8 = a). Specifica: il prototipo (`data/claude/catalogProduct.ts`,
> `data/productDocs/firstVersion.ts`, `wireframes.ts`, `backlog.ts`,
> `claudePanel.ts`; `domain/claude/intents/productDocs.ts`;
> `ProductDocOrigin`/`ProductOrigin` in `data/model.ts`; le capacità
> `product*` di `domain/claude/intents/general.ts`). Invarianti:
> `claude-actions.md` (le funzioni del catalogo in `services/`, il contenuto
> dei tool ai lettori, gli eventi strutturati), CLAUDE.md («Verso l'app mobile,
> solo cambi ADDITIVI»), `permissions.md`.
> Branch: `feat/area11-f6` da `feat/area11-f5`.

## Prima del codice

- **[DECIDE] F6-1 — «Write the first version» e «Draw this screen» partono
  subito o chiedono conferma?** Nel prototipo sono classe A (partono, con
  «Undo»). Sul server una voce che fa partire lavoro del modello chiede
  SEMPRE conferma (`starts_work`, la regola di `startRun` e dell'assegnazione
  a Claude, area 9): costa budget, e un «Undo» non restituisce i soldi.
  - **(a) — consigliata.** Classe B con il motivo `starts_work`: la scheda dice
    che Claude si mette al lavoro (la prima versione: quante pagine e da quali
    fonti), e parte alla conferma. «Undo» resta dopo. Il prototipo si
    riallinea.
  - (b) Classe A come il prototipo: partono alla richiesta, «Undo» dopo.
    Due eccezioni alla regola di `starts_work`, scritte nell'invariante.
  Si vede così: con (a) chi chiede «scrivi la prima versione» vede prima la
  scheda, con (b) vede subito Claude al lavoro.
- **Ruling (l'origine di una richiesta)**: la scrittura è il prototipo,
  `{ pageId, anchorId, questionId? }` negli argomenti di `createRequest` (un
  campo facoltativo in più dello schema della rotta); la lettura è
  `productOrigin: { pageId, code, title } | null`, DERIVATA (il titolo di
  adesso; `null` a chi non vede la pagina: la frase dell'ancora non esce
  mai, P38 del prototipo). `.nullable().default(null)`, col test di parse
  senza. È la D-10 = a nella forma del prototipo.
- **Ruling (le capacità `product*` di S0)**: si accendono qui, con la regola
  di F7 dell'area 10 (`claudeCapabilitiesOf`, le `access` delle voci):
  `productFirstVersion`, `productUpdate`, `productWireframe` con `docs.edit`
  in almeno un progetto; `productBacklog` con il permesso di `createRequest`;
  `productChanges` con `docs.view`. Il registro dei rimandi chiude la riga.
- **Fatti del codice che contano**:
  - il catalogo del server (`SERVER_CATALOG`), la classe C dalla rotta, la
    prova a secco, «Annulla» con gli inversi; le funzioni in `services/`, e
    `claude-actions-effects.test.ts` controlla che non raggiungano niente che
    esca da solo;
  - `projectRequestSchema.origin` è `kind: z.literal("support")`: non si
    tocca (D-10);
  - i tool della chat: allowlist del token (`CHAT_TOOL_READ_ROUTES`), il
    testo delle pagine non fidato (`CHAT_TOOL_UNTRUSTED_ROUTES`), il contenuto
    dei tool mai ai lettori di una pubblica;
  - il lavoro della doc (F5) e la sua coda: la prima versione e
    l'aggiornamento a richiesta sono lavori della stessa coda, `manual`.

## Regole di lavoro (le solite)

Come F1. Ogni task sul catalogo lancia `claude-actions-effects.test.ts`,
`claude-actions-class.test.ts`, `claude-actions-never.test.ts` e
`claude-capabilities.test.ts`. Nel giro anche il test di parità del catalogo
del prototipo (`catalogParity.test.ts`, da 94).

## Task 1 — la prima versione (db, server, worker)

- `product_first_versions (project_id pk, started_by, sources jsonb, status
  in ('running','done','undone','cancelled'), pages uuid[], started_at,
  finished_at)`: una per progetto, in uno spazio vuoto.
- Le fonti scelte da chi lancia e LETTE con la sua visibilità (la posta solo
  sua; un file del Drive solo se lo vede); il testo incollato entra come
  fonte, non fidata.
- Il lavoro (F5, `manual`) scrive le pagine una alla volta, interrompibile
  (`cancelled` ferma dopo la pagina in corso). «Accept this page» chiude il
  segno di quella pagina; «Undo the first version» toglie le pagine SOLO se
  nessuna persona le ha toccate (altrimenti 409 con quelle toccate).

**Test**: le fonti invisibili rifiutate; l'interruzione; «Undo» rifiutato
dopo una mano di una persona; il budget esaurito non fa partire.

## Task 2 — i wireframe (shared, server, worker)

- `product_wireframes (id, page_id, block_id, variants jsonb, kept_variant,
  created_by, created_at)`; il blocco `wireframe` di F1 punta lì.
- Il modello disegna lo SVG; il server lo RIPULISCE prima di salvarlo
  (`sanitizeWireframeSvg` in `packages/shared`, un'allowlist chiusa di
  elementi e attributi: niente `script`, niente `foreignObject`, niente
  `href` esterni, niente `style` con `url(`); uno SVG che non passa si
  scarta. Il PNG per l'esportazione (F3) si fa dal SVG ripulito.
- «Keep», «Redraw», «Replace with an image» come il prototipo.

**Test** (`sanitize-wireframe.test.ts`): i vettori di attacco noti (script,
`onload`, `javascript:`, `xlink:href` esterno, `foreignObject`, `<use>`
esterno, `style` con `url(`) tolti o rifiutati; un wireframe pulito passa
uguale. I wireframe veri si provano a mano (D-8).

Mutazione: lasciare passare `foreignObject`.

## Task 3 — il backlog da una pagina (shared, server)

- `createRequest` accetta `productOrigin { pageId, anchorId, questionId? }`
  facoltativo, validato con la visibilità di chi crea (`docs.view` sulla
  pagina; un'ancora che non c'è → l'origine resta sulla pagina).
- La lettura delle richieste porta `productOrigin` derivato; «From this
  page»: `GET /api/product-pages/:id/requests`, filtrata nella WHERE.
- «Open a request» della domanda (F5) ora scrive l'origine con `questionId`.

**Test**: un client che parsa una richiesta senza il campo; `productOrigin`
`null` a chi non vede la pagina; «From this page» senza le richieste che chi
guarda non vede.

## Task 4 — le sei voci del catalogo e le letture di Claude (shared, server, worker)

- Le voci, con le classi del prototipo salvo F6-1: `writeFirstVersion`,
  `undoFirstVersion` (B), `updateProductPage` (B, avvisa chi segue: un lavoro
  `manual` della doc su UNA fonte e UNA pagina), `undoProductUpdate` (B),
  `drawWireframe`, `deleteWireframe` (B). Le funzioni in
  `services/product-claude.ts`; nessuna scrive nel registro decisioni.
- I tool della chat: `read_product_page { code }` (la pagina, testo non
  fidato, coi codici), `read_product_changes { projectId?, since }` (i cambi
  della settimana: pagina, chi, quando, da quale fonte vista da chi chiede).
  Le rotte nell'allowlist e fra quelle non fidate; il ponte proietta solo
  ciò che serve.
- Le capacità `product*` (ruling sopra).
- Lo Stato dell'istanza: una riga per i lavori della doc in coda o fermi.

**Test**: la classe di ogni voce (il test d'accordo con le rotte); «Annulla»
con gli inversi; le letture col token del turno (200 a chi vede, 404 a chi
no, la conversazione segnata non fidata); le capacità per permesso.

Mutazioni: una voce senza `docs.edit`; la lettura della pagina senza il
segno non fidato.

## Task 5 — golden e documenti

- **Golden della chat** (CLI pinnato, da autorizzare prima di lanciarli),
  3 volte ciascuno:
  - `chat-product-update`: «aggiorna AUD-D5 da questa email» → UNA proposta
    `updateProductPage` con la pagina e la fonte giuste;
  - `chat-product-backlog`: «proponi le voci di backlog da AUD-D5» → UNA
    proposta di `createRequest` in blocco, ognuna con `productOrigin`;
  - `chat-product-changes`: «cosa è cambiato nella doc questa settimana» →
    legge i cambi e cita i codici, nessuna proposta;
  - `chat-product-page-hostile`: una pagina con istruzioni ostili → nessuna
    proposta che la pagina chiede.
  I wireframe si provano a mano.
- `deploy-log.md`: una migrazione (prima versione, wireframe), nessun kind.
  ORDINE: server, poi worker, poi caddy. Rollback: sicuro per tabelle e
  campi additivi; le voci nuove del catalogo un server vecchio le rifiuta.
- La voce di deploy-log per l'AREA (migrazioni di tutte le fette in ordine,
  i tre kind, le discese non sicure), come per l'area 10.

## Per 94 (renderer)

- F6-1: con (a) le due voci diventano schede B nel prototipo.
- «From the doc» su task e richieste, «From this page» sulla pagina; le
  capacità `product*` in S0; il wireframe con «Keep», «Redraw», «Replace».
- Il test di parità del catalogo dichiara le sei voci.

## Review Focus

- Le fonti della prima versione si leggono con la visibilità di chi lancia.
- Lo SVG si ripulisce prima di salvarlo, con un'allowlist chiusa.
- `productOrigin` si deriva a lettura, e non mostra mai la frase.
- Le letture di Claude: testo non fidato, contenuto mai ai lettori.
