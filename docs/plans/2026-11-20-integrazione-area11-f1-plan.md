# Integrazione area 11, F1 — lo spazio e l'editor: piano

> Design: `docs/plans/2026-11-20-integrazione-area11-design.md`, «F1» (D-1,
> D-3, D-7, D-9, D-11, D-12 = a). Specifica: il prototipo
> (`apps/desktop/src/renderer/data/productDocs/reads.ts`, `writes.ts`,
> `revisions.ts`, `follows.ts`; `ProductBlock`, `ProductBlockOp`,
> `ProductPage` in `data/model.ts`; `docs/area11-parity.md`). Invarianti:
> `permissions.md` (404, WHERE, archiviati), CLAUDE.md («Verso l'app mobile,
> solo cambi ADDITIVI», «Migrazioni Drizzle»), e quelle nuove del design
> («Le operazioni sono l'unica scrittura del corpo»).
> Branch: `feat/area11-f1` da `feat/integrazione-area11`.

## Prima del codice

- **Nessuna [DECIDE].** Tutto ciò che si vede è il prototipo (lo spazio, la
  pagina, l'editor, la cronologia, Segui); D-7 è già fatto (la funzione
  `product-space`, in integrazione dall'area 9).
- **Ruling (la cronologia di F1)**: in F1 la cronologia si LEGGE (prima e
  dopo per ancora, autore, quando). L'«Undo» di una revisione dalla
  cronologia nel prototipo esiste solo per le modifiche di Claude (11b): arriva
  con F5. In F1 l'annullamento è il ⌘Z dell'editor, una operazione con
  `undoOf` nella stessa sessione. Se sbagliato costa una rotta.
- **Ruling (le immagini in F1)**: il blocco `image` tiene una chiave
  dell'archiviazione d'istanza (`storageKey`), mai un data URL; il server
  rifiuta un `src` che non sia una chiave sua. Le immagini SVG sono rifiutate
  al caricamento (il prototipo: «mai SVG»). Se sbagliato costa un campo.
- **Fatti del codice che contano**:
  - la serie `-D` è `doc_page_codes` (0142): `repository_id NOT NULL`, unicità
    `(repository_id, slug)` e `(project_id, number)`, numerata sotto un
    advisory lock per progetto (`stubwise-doc-code:<project>`) dalla funzione
    `stubwise_ensure_doc_page_codes`. Il trigger delle pagine di prodotto usa
    lo STESSO lock e la stessa `max(number) + 1` per progetto: un numero non
    si riusa, anche se una pagina se ne va (la riga del codice resta);
  - lo storage d'istanza: `app.storage()`, lo stesso degli allegati e del
    Drive; l'eliminazione di un progetto toglie le chiavi di
    `storageKeysOfProject` (`apps/server/src/chat/attachments.ts`): le
    immagini di prodotto vanno aggiunte lì;
  - i link sicuri: `isSafeWebUrl` in `packages/shared/src/safe-url.ts` (la
    regola in un posto solo). Gli `href` del `RichText` passano da lì sul
    server; il desktop ha ancora una copia (`tasks-ui/Markdown.tsx`,
    `safeHref`), che 94 porta su `isSafeWebUrl` con questa fetta;
  - i permessi: `docs.view` e `docs.edit` di progetto; un progetto archiviato
    è come inesistente (`projectPermissionsFor`), e il modulo Docs spento
    spegne anche lo spazio.

## Regole di lavoro (le solite)

TDD con le mutazioni (una mutazione deve produrre codice che gira). I file di
test toccati uno per volta, interi. `pnpm -r --no-bail typecheck` a ogni task.
I dist si ribuildano dopo un cambio in shared, db o api-client. Commit con i
percorsi espliciti e `-F msgfile`; eslint, typecheck, commit e push in catena.
Migrazioni col primo numero libero e `when` crescente. I container dei test si
tolgono per id (prima/dopo). Nel giro anche `load-isolated.test.ts`,
`route-access.test.ts` e il test di parità delle migrazioni.

## Task 1 — il modello condiviso (shared)

**File**: `packages/shared/src/schemas/product-docs.ts` (nuovo, una foglia per
`load-isolated`), `packages/shared/src/product-docs/ops.ts` (nuovo).

- Gli schemi: `RichText` (testo e segni: grassetto, corsivo, link con `href`
  che passa da `isSafeWebUrl`), `ProductBlock` (le undici forme del
  prototipo), `ProductBlockOp` (le cinque), la vista di una pagina, dello
  spazio, di una revisione. Ogni `type` e `op` è uno `z.enum` letto con
  `readerSchema` (un tipo di blocco futuro arriva `UNKNOWN` e il client lo
  salta).
- `applyBlockOps(blocks, ops, { nextId })` → `{ blocks, changes } | { error }`:
  la funzione PURA del prototipo (`writeProductBlocksAs`), la stessa per il
  server (che salva) e per il client (che anticipa). Le regole: un `insert`
  con un id già usato è rifiutato salvo `undoOf` che rimette lo stesso blocco;
  `merge` tiene id e tipo del primo e restituisce `mergedFrom`; `move` non
  crea cicli; ogni cambio dice le ancore toccate (blocco o celle).

**Test** (`ops.test.ts`): i casi del prototipo (`productDocs.test.ts`,
`revisions.test.ts`, la parte delle operazioni), più: un id riusato rifiutato;
un `href` `javascript:` rifiutato; un `merge` che sposta le ancore; un tipo di
blocco ignoto letto `UNKNOWN`.

Mutazioni: accettare un id riusato; togliere `mergedFrom`.

## Task 2 — le tabelle (db)

**File**: la migrazione (primo numero libero), `packages/db/src/schema.ts`,
il suo test.

- `product_pages (id, project_id → projects on delete cascade, parent_id →
  product_pages, order int, title, blocks jsonb, block_seq int, created_by,
  created_at, updated_by, updated_at)`, con un indice `(project_id,
  parent_id, order)`.
- `product_page_revisions (id, page_id → cascade, session_id, seq, last_seq,
  actor_id, kind text check in ('edit'), changes jsonb, created_at,
  updated_at)`, unicità `(page_id, session_id)` per la revisione della
  sessione; `kind` si allarga in F5 (`undo`, e la fonte).
- `product_page_follows (page_id → cascade, user_id → users cascade, pk)`.
- `product_page_images (id, page_id → cascade, storage_key unique, mime,
  size_bytes, uploaded_by, created_at)`.
- `doc_page_codes`: `repository_id` nullable, `slug` nullable,
  `product_page_id → product_pages on delete set null` (il codice resta e non
  si riusa), CHECK «`repository_id` e `slug` insieme, oppure
  `product_page_id`», unicità parziale su `product_page_id`. Un trigger
  `AFTER INSERT ON product_pages` che prende il numero dallo stesso lock e
  dalla stessa `max + 1` del progetto.
- **Ruling (il nome `product` riservato)**: nel prototipo il conflitto è
  nell'indirizzo, `/docs/product` contro `/docs/<repository>`. Sul server il
  nome di un repository non è unico e lo sceglie il provider, quindi niente
  CHECK sui repository: le rotte dello spazio stanno sotto
  `/api/projects/:projectId/product` e `/api/product-pages/…`, che non
  toccano i Docs dei repository, e nel renderer la rotta letterale
  `/docs/product` resta PRIMA di quella parametrica. Se sbagliato costa un
  vincolo.

**Test** (`migration-<n>.test.ts`): il codice di una pagina di prodotto segue
quello dei Docs dello stesso progetto e non si riusa dopo l'eliminazione; due
inserimenti in parallelo non prendono lo stesso numero; la CHECK rifiuta una
riga con entrambi; il journal in fila.

Mutazione: il trigger senza il lock (il test in parallelo deve cadere).

## Task 3 — leggere e organizzare lo spazio (server)

**File**: `services/product-docs.ts` (nuovo), `routes/product-docs.ts` (nuovo),
la registrazione in `app.ts`.

Le rotte (tutte `config.access` di progetto: `docs.view` per leggere,
`docs.edit` per scrivere):
- `GET /api/projects/:projectId/product` → lo spazio (albero, `pageCount`,
  cinque recenti, `permissions.edit`), come `getProductSpace`;
- `GET /api/product-pages/by-code/:code` → la pagina, con briciole,
  `permissions { edit, delete }` (delete solo senza figlie), e le decisioni dei
  blocchi `decision` come le vede chi guarda (null se non vede il loro
  progetto). Un codice in un progetto visibile senza `docs.view`: 403 anche
  se la pagina non c'è (la risposta non dice se c'è); altrimenti 404;
- `POST /api/projects/:projectId/product/pages { parentId?, title, afterId? }`;
- `PATCH /api/product-pages/:id { title?, parentId?, afterId? }` (rinomina e
  sposta, senza cicli, l'ordine rinumerato fra i fratelli);
- `DELETE /api/product-pages/:id` (409 `has_children`).

**Test** (`product-docs.test.ts`): `docs.view` legge e non scrive; `docs.edit`
scrive; un non membro 404; un progetto archiviato 404; il modulo Docs spento
404; un ciclo rifiutato; l'eliminazione con figlie 409; la regola del 403 sul
codice; le decisioni invisibili `null`.

Mutazione: leggere senza filtro di progetto nella WHERE dell'albero.

## Task 4 — scrivere a operazioni, la cronologia, Segui (server)

**File**: `services/product-docs.ts`, `routes/product-docs.ts`.

- `POST /api/product-pages/:id/ops { sessionId, baseSeq, ops, undoOf? }`:
  - sotto `SELECT … FOR UPDATE` della pagina; `baseSeq` più vecchio
    dell'ultima revisione di un'ALTRA sessione → 409 `stale` con le revisioni
    mancanti (il client riapplica; F4 ci appoggia la scrittura a due mani);
  - `applyBlockOps` di shared; i riferimenti validati con la visibilità di chi
    salva (un file del Drive, una decisione, un wireframe di un progetto che
    non vede → 422); le immagini solo con una chiave di
    `product_page_images` della stessa pagina;
  - la revisione della sessione si allunga (`last_seq`), o nasce;
  - tetti: 2000 blocchi per pagina, 50 000 caratteri per blocco, 200
    operazioni per chiamata (Ruling: il prototipo non ne ha; costano una
    costante);
- `GET /api/product-pages/:id/revisions` → dalla più recente, con il nome
  dell'autore (R-G5: null se chi guarda non lo vede) e i cambi per ancora;
- `PUT`/`DELETE /api/product-pages/:id/follow`;
- `POST /api/product-pages/:id/images` (multipart, 5 MB, mai SVG, il tipo
  dai byte e non dal nome) e `GET /api/product-pages/:id/images/:imageId`
  (coi permessi della pagina); `storageKeysOfProject` impara le immagini.

**Test** (`product-docs-ops.test.ts`): un salvataggio di due sessioni in
fila; `stale` con le revisioni mancanti; un id riusato 422; un `href`
`javascript:` 422; un riferimento a un file del Drive invisibile 422;
l'immagine SVG rifiutata; l'eliminazione del progetto toglie le chiavi delle
immagini; seguire e smettere; due salvataggi in parallelo sulla stessa
pagina non perdono operazioni (il `FOR UPDATE`).

Mutazioni: senza `FOR UPDATE`; il riferimento del Drive senza visibilità.

## Task 5 — l'api-client e i documenti

- `packages/api-client`: il gruppo `productDocs` con le rotte di questa
  fetta, le risposte parsate con `readerSchema` (è la forma che il renderer
  vero userà).
- `deploy-log.md`: una migrazione (tabelle nuove, `doc_page_codes` più
  largo), nessuna env, nessun kind. ORDINE: server, poi caddy (il renderer).
  Rollback: sicuro per le tabelle (un server vecchio le ignora); ⚠️
  `doc_page_codes.repository_id` nullable: un server vecchio che legge i
  codici dei Docs per repository non vede le righe di prodotto, e non ne ha
  bisogno; il trigger dei Docs non cambia.
- Il registro dei rimandi e `apps/desktop/docs/integration-area11.md`
  (nuovo, la tabella delle voci come per l'area 10).

## Per 94 (renderer)

- Lo spazio si accende con questa fetta (`product-space`), con la card
  Product nella Home dei Docs.
- `applyBlockOps` e gli schemi stanno in shared: l'editor del prototipo li
  importa al posto della sua copia.
- Il 409 `stale` dà le revisioni mancanti: l'editor le riapplica e riprova.
- `safeHref` del desktop passa su `isSafeWebUrl`.

## Review Focus

- Il corpo si scrive SOLO a operazioni, e un id non si riusa mai.
- Ogni riferimento (Drive, decisione, wireframe, immagine) è validato con la
  visibilità di chi salva.
- Il codice `-D` viene dallo stesso lock e dalla stessa sequenza dei Docs.
- 404 per invisibile e archiviato; il 403 della pagina non dice se c'è.
