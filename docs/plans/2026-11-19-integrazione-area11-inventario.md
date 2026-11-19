# Area 11 — La documentazione di prodotto: inventario

> **Bozza**, 19 nov 2026, su richiesta di stubwise-46: inventario per
> l'integrazione dell'area 11 nell'app nuova (`apps/desktop`). Lato renderer:
> stubwise-94 (questa versione). Lato server: stubwise-72, da aggiungere. È
> solo un documento: qui non si prende nessuna decisione, e le domande stanno
> in fondo (D-n).
>
> **La premessa**: la documentazione di prodotto vive DENTRO Stubwise, non in
> Google Docs (decisione del maintainer, 25 ott 2026). È scritta dal PO/PM col
> cliente, anche prima che esista codice, ed è distinta dai Docs generati dai
> repository (area 5). Claude la tiene aggiornata da sé, dalle fonti del
> progetto.
>
> Fonti:
> - il design `docs/plans/2026-11-05-desktop-area11-product-docs-design.md`,
>   coi piani `…-area11a-plan.md` (lo spazio, l'editor, commenti, cronologia,
>   la scrittura dal vivo, l'esportazione) e `2026-11-06-desktop-area11b-plan.md`
>   (Claude nella doc di prodotto);
> - nel prototipo: `apps/desktop/docs/area11-parity.md` (le voci e, nelle
>   sezioni «Per il prodotto vero», ciò che manca al server di oggi) e
>   `apps/desktop/docs/ossatura-follow-ups.md` («Area 11a/11b — minori aperti»);
> - il registro dei rimandi (`docs/plans/integrazione-registro-rimandi.md`,
>   «Area 11»: l'origine di una richiesta dalla doc di prodotto, le azioni di
>   Claude dell'area 11; e la riga delle domande della doc nel riquadro);
> - le parti dell'area 5 che la lasciavano fuori
>   (`apps/desktop/docs/integration-area5-f1.md`,
>   `docs/plans/2026-11-11-integrazione-area5-docs-design.md`).
>
> **La differenza con le aree 9 e 10**: dell'area 11 nell'app non c'è niente.
> Nessun adattatore (`data/backend/real/stubs.generated.ts`: `productDocs =
> notIntegratedNamespace("productDocs")`), nessuna rotta del server, nessuna
> tabella. L'area è grande: 11a è un editor a blocchi collaborativo, 11b è un
> lavoro del worker che legge le fonti e scrive nella doc.

## Le voci

Gli stessi titoli nei due lati:

1. Lo spazio Product (albero, indice, pagine)
2. L'editor a blocchi e il salvataggio
3. Commenti e menzioni
4. La cronologia (revisioni, «Undo» per autore)
5. Seguire una pagina
6. La scrittura dal vivo (presenza, cursori, «X sta scrivendo»)
7. L'esportazione (PDF, Word)
8. La ricerca «In Product» e le citazioni nella chat dei Docs
9. Claude aggiorna la doc dalle fonti (il segno, «Looks good», «Undo»)
10. Le domande di Claude
11. La prima versione con Claude
12. Le voci di backlog da una pagina (l'origine «From the doc»)
13. I wireframe («Draw this screen»)
14. Le notifiche della doc di prodotto
15. Le azioni di Claude dell'area 11 (il catalogo)
16. Le superfici fuori dallo spazio (Docs, Home, riquadro, task e richieste)

## Lato server

> Di stubwise-72 (19 nov 2026), su `feat/integrazione-area9` 91f3174dc,
> partendo da `apps/desktop/docs/area11-parity.md`, «Per il prodotto vero»
> (11a e 11b). Per ogni voce: cosa ha già il server (rotte, tabelle, job del
> worker, tool della chat, catalogo), le lacune e lo stato (**c'è**, **in
> parte**, **manca**).

### I fatti del codice che cambiano il lavoro

- **La serie `-D` è legata a un repository.** `doc_page_codes` (0142) ha
  `repository_id NOT NULL` e l'unicità `(repository_id, slug)`. Il codice lo
  dà il trigger `doc_pages_code` a ogni `doc_pages` nuova. Una pagina di
  prodotto non ha repository: la serie condivisa vuole una colonna
  `product_page_id` (con `repository_id` nullable e una CHECK «uno dei due»)
  e un trigger gemello, oppure un repository finto `product`. Il prototipo
  riserva quel nome fra i repository, ma sul server un repository porta git,
  mirror, webhook, grafo e il giro notturno (D-9).
- **I permessi ci sono**: `docs.view` e `docs.edit` (e `docs.generate`) sono
  permessi di progetto, e il modulo Docs del progetto (fetta 4) spegne la
  sezione. Valgono le regole di sempre: invisibile = 404, nella WHERE, e un
  archiviato come uno che non c'è (F6, `inProjects` / `projectNotArchived`).
- **I file hanno già dove stare.** Lo storage d'istanza (S3) del Drive e
  degli allegati: le immagini delle pagine (D-3 a) ci entrano. Ma
  l'eliminazione di un progetto (F6) toglie dallo storage SOLO le chiavi che
  `storageKeysOf` conosce (`project-archive.ts`). Le immagini di prodotto
  vanno aggiunte lì, o restano orfane sul volume.
- **Il canale in tempo reale non c'è per pagina.** L'SSE di oggi è delle
  sessioni degli agenti (`GET /api/agent-sessions/:id/stream`) e della chat
  LLM: legato a una sessione, monodirezionale, coi permessi della
  sessione. La presenza a due mani (D-2 a) è un canale nuovo, coi permessi
  ricalcolati a ogni evento (`docs.edit` per scrivere in presenza).
- **L'origine della richiesta NON si allarga in modo additivo.**
  `projectRequestSchema.origin` è un oggetto con `kind: z.literal("support")`,
  non un'unione aperta. Un `kind: "product_doc"` fa fallire il parse
  dell'INTERA lista delle richieste ai client vecchi (app e desktop di
  prima). Serve un campo a sé, `productOrigin` (nullable, default null), o
  un'unione con un client che la apra (D-10).
- **Tre `notification_kind` nuovi** (`product_doc.mention`, `.updated`,
  `.question`).
  - Ognuno è una `ALTER TYPE … ADD VALUE` in uno statement a sé, non usabile
    nello stesso batch.
  - Ognuno ha la sua voce di rollback: niente discesa d'immagine sul server
    finché ne esistono righe (500 su `/api/inbox`).
  - I campi della card si derivano a lettura (CLAUDE.md), compreso
    `objectGone`.
- **Il worker ha già i pezzi del 11b, non il lavoro.** Ci sono:
  - il giro notturno, con la coda `nightly_items` che riprende dopo la quota
    e i riassunti dei commit una volta sola;
  - il serializer per progetto;
  - i job `held`, con `heldReasonSchema` = `limit` | `budget` | `other`;
  - i punti d'arrivo delle fonti: la posta classificata (il poller Google),
    le riunioni (`meeting_notes`), il registro decisioni, la chiusura di una
    task, il rilascio.
  Manca il job che rilegge una fonte e scrive in una pagina.
  `heldReasonSchema` non dice «per pagina»: la riga «riprende quando il
  budget torna» per pagina è una tabella o un campo nuovi.
- **Le fonti private hanno le loro regole.** L'audience `mailbox_owner` non
  include MAI gli admin (`docs/invariants/mail-calendar.md`), e la posta
  non entra nella cronologia della ricerca. La §21 del prototipo («da
  un'email di <titolare>», senza oggetto né testo a chi non la può aprire) è
  la stessa famiglia: la vista della fonte va calcolata dal server per chi
  guarda, mai dal client.
- **Il registro decisioni non è mai scritto dall'AI**
  (`decisions-never-ai.test.ts`, sul sorgente e a runtime). Il lavoro del
  11b non deve nominare chi lo scrive. Il prototipo lo prova con
  `neverWritesDecisions.test.ts`: va portato come test del worker.
- **I commenti dei ticket hanno già la regola del testo eliminato** (`body
  = ''` con una CHECK, `deleted_at`). I commenti di prodotto sono un'altra
  tabella, ma la stessa regola conviene da subito (il prototipo non
  modifica né elimina, minore aperto).
- **La ricerca dei Docs è ibrida** (pgvector bge-m3 più full-text,
  `retrieveChunks…` in `@stubwise/db`) sui `doc_chunks` delle pagine di un
  repository. «In Product» e le citazioni nella chat dei Docs vogliono i
  chunk anche per le pagine di prodotto, e il loro embedding: un job del
  worker, che è l'unico che chiama ollama per i Docs.
- **`docx` è solo del desktop** (`apps/desktop`, con l'override di
  `@types/node` nella radice). Un'esportazione sul server (D-4 b) porta la
  dipendenza nell'immagine del server.
- **Le azioni di Claude dell'area 11** entrano nel catalogo del server come
  le altre. Le funzioni del catalogo stanno in `services/`, mai in una rotta:
  da F7 il test `claude-actions-effects.test.ts` controlla che il catalogo
  non raggiunga niente che esca da solo. Il job del 11b, invece, scrive dal
  worker, fuori dal catalogo, col segno `via` della sua revisione.
- **Il registro delle modifiche**: l'area 11 nel prototipo non vi scrive.
  Se il server ne scrivesse (pagina creata, eliminata, spostata), il tipo va
  dichiarato nel catalogo del registro (`packages/shared/src/change-log.ts`)
  e il prototipo allineato.

### Le voci

1. **Lo spazio — manca.** Mancano tabelle, rotte, la serie `-D` per le
   pagine senza repository (D-9) e il 404 per l'archiviato.
2. **L'editor e il salvataggio — manca.** Mancano le operazioni (D-1), gli id
   dei blocchi mai riusati (una sequenza per pagina, non `max + 1`), la
   validazione degli `href` sul server (solo `http(s)`, la terza copia della
   tabella di casi) e i riferimenti a Drive, decisioni e wireframe validati
   con la visibilità di chi salva.
3. **Commenti e menzioni — manca.** Mancano la tabella, le rotte,
   `product_doc.mention` e il testo eliminato come per i ticket.
4. **La cronologia — manca.** Mancano le revisioni per sessione, «Undo»
   come revisione nuova e lo stato di «Undo» calcolato dal server per chi
   guarda.
5. **Seguire — manca.** Una tabella `(page_id, user_id)` e i destinatari di
   Claude (chi segue, altrimenti chi ha `docs.edit`, mai Claude).
6. **Dal vivo — manca** (D-2). Il canale non c'è.
7. **L'esportazione — manca** (D-4). Serve una lettura apposta, con i
   commenti esclusi.
8. **La ricerca e le citazioni — manca.** Mancano i chunk, l'embedding (un
   job del worker), l'ambito nella ricerca globale e le citazioni `doc` della
   chat dei Docs (`chat/citations.ts`) estese alle pagine di prodotto.
9. **Claude dalle fonti — manca.** Mancano il job del worker (D-5), la
   tabella dei segni, `decideFact` in `@stubwise/shared` (una regola per
   worker, server e client), e il prompt più il controllo sul risultato, a
   due livelli.
10. **Le domande — manca.** Sono commenti di Claude con la loro parte di
    domanda, una vista per chi legge (mai `sourceRef`), la risposta e
    `product_doc.question`.
11. **La prima versione — manca.** Un job interrompibile, le fonti viste da
    chi lancia, «Undo» dalle foglie.
12. **Il backlog da una pagina — manca**, e l'origine non è additiva sullo
    schema di oggi (D-10).
13. **I wireframe — manca.** Chi li disegna è il modello, e lo SVG
    prodotto va ripulito sul server (niente script, niente riferimenti
    esterni) prima di salvarlo e di esportarlo come PNG.
14. **Le notifiche — manca**: tre kind, col rollback di ciascuno.
15. **Le azioni di Claude — manca**: sei voci nel catalogo, più le letture
    per il modello (le pagine, i cambi della settimana) come tool della
    chat con l'allowlist del ponte.
16. **Le superfici fuori dallo spazio — manca.** La card nella Home dei Docs,
    «Decide», «From the doc» (dopo D-10) e il lavoro nello Stato
    dell'istanza (un `kind` nuovo nelle sue righe).

### Le fette viste dal server

- **S11-1, lo spazio e l'editor**: tabelle, serie `-D`, operazioni,
  revisioni, seguire, 404 e archiviati, storage con l'eliminazione del
  progetto.
- **S11-2, commenti e menzioni**: `product_doc.mention` col rollback.
- **S11-3, ricerca, citazioni, esportazione**: chunk ed embedding dal worker.
- **S11-4, dal vivo**: il canale, se D-2 = a.
- **S11-5, Claude dalle fonti e le domande**: il job, i segni, `decideFact`
  condivisa, due kind.
- **S11-6, prima versione, wireframe, backlog, catalogo**.

### [DECIDE] del server

- **D-9 — La serie `-D` per le pagine di prodotto.**
  - **(a) consigliata**: `doc_page_codes` con `product_page_id` accanto a
    `repository_id` (uno dei due, CHECK) e un trigger sulle pagine di
    prodotto: la stessa numerazione per progetto, mai riusata, e le
    citazioni `doc` che già la leggono.
  - (b) un repository finto `product` per progetto: niente colonne nuove, ma
    un repository che git, mirror, webhook, grafo e giro notturno devono
    imparare a saltare, ovunque.
- **D-10 — L'origine «dalla doc» di una richiesta.**
  - **(a) consigliata**: un campo additivo `productOrigin: { pageId, pageCode,
    anchorId, questionId } | null` (default null), accanto a `origin`, che
    resta `support`. Un client vecchio lo ignora.
  - (b) `origin` come unione discriminata: più pulita, ma i client di prima
    non parsano più le liste delle richieste che ne contengono una.
- **D-11 — Dove sta il corpo.**
  - **(a) consigliata**: un `jsonb` per pagina coi blocchi, più una sequenza
    di id per pagina, e le revisioni a parte. Le operazioni della D-1
    lavorano sul jsonb sotto un `FOR UPDATE` della pagina.
  - (b) una riga per blocco: ancore e revisioni per blocco più naturali, ma
    ogni lettura di una pagina ricompone l'ordine.
- **D-12 — Le pagine di prodotto nel registro delle modifiche.**
  - **(a) consigliata**: no, come il prototipo: la cronologia della pagina è
    la sua storia, e il registro resta delle impostazioni e dell'accesso.
  - (b) sì per creare, eliminare e spostare: il prototipo va allineato.

## Lato renderer

> Di stubwise-94. Il dettaglio schermata per schermata del prototipo è in
> `apps/desktop/docs/area11-parity.md` (voce, file, test) e non si ricopia.
> Qui per ogni voce: cosa fa il prototipo, cosa fa oggi l'app, la lacuna.
> Stato, visto dal renderer: **c'è**, **in parte**, **manca**.

### 1. Lo spazio Product — manca

- **Prototipo**: `/p/<CODE>/docs/product` (`pages/productDocs/ProductSpace.tsx`):
  l'albero delle pagine (`ProductTree.tsx`: trascina per ordinare e
  annidare, F2 per rinominare, «⋯» con Sposta, Indenta, Elimina; Elimina
  spento su una pagina con figlie), la barra (stato del salvataggio,
  presenze, Segui, Commenti, Cronologia, Esporta, «⋯» con Copia link ed
  Elimina), l'indice (`ProductIndex.tsx`: «Recently updated», «All pages»,
  «New page»). Le pagine hanno un codice della serie `-D` **condivisa** con i
  Docs dei repository (`ACQ-D5`), e il nome di repository `product` è
  riservato. L'accesso è `docsAccess`: `docs.view` per leggere, `docs.edit`
  per scrivere, invisibile come inesistente.
- **App oggi**: la rotta NON è dietro un flag (sta nella sezione `docs`, che
  è accesa). Un indirizzo `/p/X/docs/product` apre lo spazio, che chiama
  `productDocs.getProductSpace`, rifiutato come «non integrato»: la pagina
  dice «Couldn't load» (`productDocs.space.loadError`), non «Coming soon».
  Nessun link ci porta: la Home dei Docs nasconde la card Product
  (`real/docs.ts`: `product: null`). Vedi D-7.
- **Lacuna**: lettura dello spazio e della pagina, creazione, rinomina,
  spostamento, eliminazione; l'adattatore vero.

### 2. L'editor a blocchi e il salvataggio — manca

- **Prototipo**: `editor/BlockEditor.tsx`, menu «/», barra della selezione,
  link, immagini (data URL fino a 5 MB, mai SVG), tabelle, blocchi di file
  del Drive, di decisione e di wireframe. Il corpo è una lista di blocchi
  con id **mai riusati** (`ProductBlock`), il testo `RichText` (grassetto,
  corsivo, link). Il salvataggio è a **operazioni** (`set`, `insert`,
  `delete`, `move`, `merge`, `saveProductBlocks(pageId, ops, {sessionId,
  undoOf})`): sul blur, sui gesti di struttura e dopo 800 ms senza battere.
  ⌘Z locale per sessione (`undoOf`).
- **App oggi**: niente.
- **Lacuna**: le operazioni sul server (validazione degli id, dei link e
  dei riferimenti a Drive, decisioni, wireframe), le revisioni per sessione,
  dove vanno le immagini (D-3).

### 3. Commenti e menzioni — manca

- **Prototipo**: fili ancorati a un blocco o a una cella, con la frase
  citata (≤200 caratteri), risposte, @menzioni (una notifica
  `product_doc.mention` per lettore menzionato), «Resolve»/«Reopen», «Sentence
  deleted» quando l'ancora non c'è più. Commentare chiede `docs.edit`.
  Niente modifica né eliminazione di un commento (minore aperto del 11a).
- **App oggi**: niente.
- **Lacuna**: tabella, rotte, la notifica (vedi 14).

### 4. La cronologia — manca

- **Prototipo**: `history/HistoryPanel.tsx`, prima e dopo per ancora, una
  revisione per sessione dell'editor (`seq`/`lastSeq`). Per le modifiche di
  Claude: «per conto di», la fonte, «Undo» e «Undo all». Le versioni della
  pagina SONO le revisioni; niente «Restore» (minore aperto).
- **App oggi**: niente.
- **Lacuna**: la lettura delle revisioni con lo stato di «Undo» per chi
  guarda (calcolato dal server), e l'«Undo» di una revisione come revisione
  nuova (`kind: "undo"`).

### 5. Seguire una pagina — manca

- **Prototipo**: `FollowButton.tsx`, per chi legge la pagina. I destinatari
  delle notifiche di Claude sono chi segue, o (nessuno) chi ha `docs.edit`;
  mai Claude (`productDocRecipients`).
- **App oggi**: niente.

### 6. La scrittura dal vivo — manca

- **Prototipo**: gli avatar di chi è sulla pagina, i cursori degli altri,
  «X is writing here» (`live/*`). È un copione finto
  (`data/seed/productDocs/presence.ts`): non c'è nessun canale di rete.
- **App oggi**: niente.
- **Lacuna**: un canale per pagina (D-2) e il blocco di una sezione mentre
  un altro ci scrive, che serve anche a Claude («aspetta chi scrive nella
  stessa sezione», `productPending`).

### 7. L'esportazione — manca

- **Prototipo**: PDF (`printToPDF`) e Word (`docx`), della pagina o dello
  spazio intero; i commenti non si esportano; i wireframe come immagine.
- **App oggi**: niente.
- **Lacuna**: la lettura per l'esportazione (`getProductExport`) e dove si
  compone il file (D-4). Sul web non c'è `printToPDF`.

### 8. La ricerca «In Product» e le citazioni — spenta

- **Prototipo**: ⌘K con l'ambito «In Product» (`palette/CommandPalette.tsx`),
  e le pagine di prodotto citate nella chat dei Docs (`data/docs/chat.ts`,
  `LinkPicker.tsx`).
- **App oggi**: la ricerca è spenta dalla funzione `product-docs`
  (`data/queries/productDocs.ts`); `ComingSoon.test.tsx` verifica che
  `productDocs.searchProductPages` non parta mai.

### 9. Claude aggiorna la doc dalle fonti — manca

- **Prototipo**: `applyProductSource` (sincrono): per una fonte attribuita a
  un progetto (un'email classificata, una riunione, una decisione
  registrata, una task chiusa, un rilascio) Claude scrive nella pagina **come
  il titolare della fonte**, col segno `via: "claude"`; una revisione per
  fonte e pagina, un gruppo. Il segno nel testo (`ProductClaudeMark.tsx`:
  la fonte, «Looks good», «Undo»). Si ferma col budget del mese esaurito o la
  coda in pausa (un lavoro `product_doc_update` in attesa), e aspetta chi sta
  scrivendo nella stessa sezione. Manda una card `product_doc.updated`.
  **Non c'è un modello**: i fatti delle fonti sono scritti a mano nel seme
  (`data/seed/productDocs/facts.ts`), e la regola pura `decideFact`
  (`domain/productDocs/claudeRule.ts`) decide se scrivere, chiedere o
  lasciar stare.
- **App oggi**: niente.
- **Lacuna**: il lavoro del worker (D-5), i segni salvati, la lettura dei
  segni, «Looks good» e «Undo» di un segno, e `decideFact` in un package
  condiviso (la stessa regola per worker, server e client).

### 10. Le domande di Claude — manca

- **Prototipo**: quando la fonte è vaga, contraddice una persona o il testo,
  o chi la porta non ha i permessi, Claude non scrive: apre una domanda,
  cioè un commento di Claude ancorato al punto, con le tre scelte «Update it»
  / «Keep as is» / «Open a request», la consigliata per prima
  (`comments/QuestionThread.tsx`). La domanda compare in Home «Decide», nel
  riquadro («questions to close») e come card `product_doc.question`. «Open a
  request» apre una richiesta con l'origine `product_doc`.
- **App oggi**: le domande nel riquadro e in Home sono spente dalla funzione
  `product-docs` (`ClaudePanel.tsx`, `queries.ts`).
- **Lacuna**: le domande sul server (come commenti di Claude con la loro
  parte di domanda), la risposta (`answerProductQuestion`), l'origine della
  richiesta (vedi 12).

### 11. La prima versione con Claude — manca

- **Prototipo**: in uno spazio vuoto, chi può scrivere ha «Write the first
  version with Claude» (`claude/FirstVersionDialog.tsx`): sceglie le fonti
  (email, riunioni, testo incollato, file del Drive) e Claude scrive le
  pagine una alla volta; poi «Accept this page» o «Undo the first version»
  (solo se nessuno le ha toccate). Spenta col budget esaurito; per chi legge,
  spenta col motivo e «Who?». È una bozza del seme scritta a tempo, non un
  modello.
- **App oggi**: niente.
- **Lacuna**: il lavoro, le fonti leggibili da chi chiede, lo stato della
  prima versione per pagina.

### 12. Le voci di backlog da una pagina — manca

- **Prototipo**: «Propose backlog items» (la pagina o una sezione, dal
  riquadro): una scheda di `createRequest` in blocco con l'origine
  `{kind: "product_doc", pageId, anchorId}`. Sulla pagina «From this page»
  (`LinkedRequests`), e su richieste e task «From the doc»
  (`ProductOriginLine.tsx`).
- **App oggi**: niente. Il registro dei rimandi ha «Origine di una richiesta
  dalla documentazione di prodotto».
- **Lacuna**: l'origine `product_doc` sulle richieste (campo additivo), la
  lettura delle richieste nate da una pagina.

### 13. I wireframe — manca

- **Prototipo**: «Draw this screen» (`ClaudePageGestures.tsx`): un blocco
  wireframe con varianti, «Keep», «Redraw», «Replace with an image». Gli SVG
  sono del seme, scelti per parola.
- **App oggi**: niente.
- **Lacuna**: chi li disegna davvero (il modello, D-8), dove si salvano,
  come si esportano.

### 14. Le notifiche della doc di prodotto — manca

- **Prototipo**: tre tipi, `product_doc.mention`, `product_doc.updated`,
  `product_doc.question`, coi titoli composti a lettura e «objectGone» se la
  pagina non c'è più; nessun bottone sulla card. **Non stanno nel catalogo
  degli avvisi**: i destinatari sono fissi (`productDocRecipients`, le
  menzioni).
- **App oggi**: niente (i tipi non esistono sul server).
- **Lacuna**: tre `notification_kind` nuovi (con la loro voce di rollback,
  come ogni kind nuovo), D-6.

### 15. Le azioni di Claude dell'area 11 — manca

- **Prototipo**: sei voci nel catalogo (`data/claude/catalogProduct.ts`),
  tutte con «Who?» `editDocs` e senza riconferma:

  | Voce | Classe | Annulla |
  |---|---|---|
  | `writeFirstVersion` | A | sì (`undoFirstVersion`) |
  | `undoFirstVersion` | B | no |
  | `updateProductPage` | B (avvisa chi segue) | sì (`undoProductUpdate`) |
  | `undoProductUpdate` | B | no |
  | `drawWireframe` | A | sì (`deleteWireframe`) |
  | `deleteWireframe` | B | no |

  Il motore di intenti (`domain/claude/intents/productDocs.ts`) riconosce sei
  gesti: la prima versione, «aggiorna <pagina> da questa email/riunione», le
  voci di backlog da una pagina o una sezione, «disegna questo schermo», «cosa
  è cambiato nella doc questa settimana» (una lettura), e «apri una richiesta
  dalla domanda».
- **App oggi**: nessuna di queste voci è nel catalogo del server
  (`CLAUDE_PROPOSABLE_FNS`). Il test di parità del catalogo
  (`data/claude/catalogParity.test.ts`) le dichiarerà quando arrivano.
- **Lacuna**: le voci sul server, le letture per il modello (le pagine, i
  cambi della settimana), le frasi delle schede nell'adattatore.

### 16. Le superfici fuori dallo spazio — manca

- **Prototipo**: la card Product nella Home dei Docs (`DocsHome.tsx`), le
  domande in Home «Decide» (`ClaudeDecisionItem.tsx`), le card delle
  notifiche (`NotificationItem.tsx`), «From the doc» su task e richieste,
  le pagine di prodotto nella chat dei Docs, il lavoro `product_doc_update`
  nello Stato dell'istanza.
- **App oggi**: tutte spente o vuote (la card Product è `null`, le domande
  spente da `product-docs`).

### Cosa resta «Coming soon» nell'app

- Niente dell'area 11 dice «Coming soon»: la rotta dello spazio è raggiungibile
  per indirizzo e risponde con un errore di caricamento (D-7).
- La funzione `product-docs` (spenta) tiene fuori: le domande della doc nel
  riquadro e in Home «Decide», la ricerca «In Product».
- La Home dei Docs nasconde la card Product (`product: null`).

### Le differenze di parità attese (dove il prototipo ha più del server, o diverso)

- **Il modello al posto dei fatti del seme**: nel prototipo ciò che una fonte
  dice è scritto a mano, e la regola `decideFact` è deterministica. Col
  modello vero la parità si misura sull'**esito** (scritto, chiesto, lasciato
  stare; con quale segno e quale fonte), non sulle frasi, come per l'area 10
  (D-8).
- **La scrittura dal vivo**: nel prototipo è un copione; servono un canale e
  una politica sui conflitti fra due persone sulla stessa sezione (D-2).
- **Le immagini**: data URL nel corpo, fino a 5 MB (D-3).
- **L'esportazione**: `printToPDF` c'è solo nel desktop; il web ha la stampa
  del browser (D-4).
- **La serie dei codici `-D` condivisa** coi Docs dei repository, e il nome
  `product` riservato fra i repository: due regole che il server deve
  avere uguali.
- **Le notifiche fuori dal catalogo degli avvisi**: «Preferenze → Notifiche»
  non le elenca (D-6).
- **Il registro delle modifiche**: l'area 11 non scrive voci nel registro
  (la cronologia della pagina è la sua storia). Se il server le scrivesse,
  il prototipo andrebbe allineato.
- **Il budget e la coda**: le attese del prototipo (`holdJob`, `aiBlockFor`)
  diventano quelle vere del worker (quota, pausa della coda, giro notturno).

### Le fette viste dal renderer

- **R11-1 — Lo spazio e l'editor** (voci 1, 2, 4, 5): leggere, scrivere a
  operazioni, la cronologia con «Undo», seguire. Si accende lo spazio, con la
  card nella Home dei Docs.
- **R11-2 — Commenti, menzioni, notifiche** (voci 3, 14).
- **R11-3 — Ricerca, citazioni, esportazione** (voci 7, 8).
- **R11-4 — La scrittura dal vivo** (voce 6), quando c'è il canale.
- **R11-5 — Claude dalle fonti e le domande** (voci 9, 10, 16): il segno,
  «Looks good», «Undo», le domande ovunque si vedono; si accende
  `product-docs`.
- **R11-6 — Prima versione, wireframe, backlog, azioni di Claude** (voci 11,
  12, 13, 15).

## [DECIDE]

- **D-1 — Come si salva il corpo di una pagina.**
  - **(a) consigliata**: come il prototipo, un documento a blocchi con id
    stabili, scritto a **operazioni** (`set`, `insert`, `delete`, `move`,
    `merge`) con la sessione dell'editor: le revisioni per blocco, le ancore
    dei commenti e dei segni di Claude reggono solo così.
  - (b) il corpo intero (Markdown o JSON) a ogni salvataggio: più semplice,
    ma ancore e revisioni per blocco si ricalcolano per differenza.
- **D-2 — La scrittura dal vivo.**
  - **(a) consigliata**: un canale per pagina (SSE, come lo stream delle
    sessioni degli agenti) per presenza, cursori e blocchi nuovi, e il
    blocco «X sta scrivendo qui» per sezione.
  - (b) rilettura a intervalli, senza cursori: niente canale nuovo, ma la
    scrittura a due mani torna quella di un wiki.
  - (c) fuori dalla prima integrazione (una persona per volta, «Saved»).
- **D-3 — Le immagini.**
  - **(a) consigliata**: nell'archiviazione dell'istanza (S3, come gli
    allegati e il Drive), col blocco che tiene il riferimento.
  - (b) data URL nel corpo come il prototipo: pagine pesanti e backup grandi.
- **D-4 — L'esportazione.**
  - **(a) consigliata**: composta nel client come il prototipo (`printToPDF`
    nel desktop, la stampa del browser sul web; `docx` nel renderer), su una
    lettura apposta del server.
  - (b) sul server: un file uguale per tutte e due le build, ma una
    dipendenza nuova sul server.
- **D-5 — Quando Claude legge le fonti.**
  - **(a) consigliata**: un lavoro del worker accodato all'arrivo della fonte
    (email classificata, riunione pronta, decisione, task chiusa, rilascio),
    sotto la quota e la pausa della coda, con la ripresa nel giro notturno;
    a richiesta dal riquadro (`manual`).
  - (b) solo nel giro notturno: più semplice e prevedibile, ma la doc resta
    indietro di un giorno.
- **D-6 — Le notifiche della doc nel catalogo degli avvisi.**
  - **(a) consigliata**: fuori, come il prototipo (la specifica): destinatari
    fissi, chi segue la pagina e le menzioni; chi non vuole le card smette di
    seguire.
  - (b) dentro il catalogo (Preferenze → Notifiche le elenca, con app e
    telefono): il prototipo va allineato.
- **D-7 — Lo spazio finché non c'è il server.**
  - **(a) consigliata**: la rotta `/p/<CODE>/docs/product` dietro una
    funzione (`product-space`, spenta): l'indirizzo dice «Coming soon», non un
    errore di caricamento (invariante: niente acceso senza appoggio). Si
    accende con R11-1.
  - (b) com'è oggi: nessun link porta lì, e l'errore resta raggiungibile
    solo scrivendo l'indirizzo.
- **D-8 — La parità di ciò che fa Claude nella doc.**
  - **(a) consigliata**: sull'esito, con gli scenari golden del modello vero
    (come la D-6 dell'area 10): per ogni fonte del seme, scrive / chiede /
    lascia stare, col segno e la fonte giusti. I wireframe dal modello sono un
    rischio a sé: si provano a mano.
  - (b) sulle frasi come il prototipo: col modello vero non regge.
