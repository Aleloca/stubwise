# Area 11a — parità con il web (5 nov 2026)

Il web non ha la doc di prodotto: la sezione Docs di oggi (`/docs`) è la
documentazione **autogenerata dai repository** (pagine per repository, grafo,
chat RAG), e non esiste un posto in cui una persona scrive, commenta e
cronologizza a mano la documentazione del *prodotto*. Qui non c'è quindi una
parità da chiudere: c'è una riga per ogni voce **nuova** del 11a, dove vive
nel prototipo e il test che la esercita (titolo fra virgolette, anche solo
l'inizio). Percorsi relativi a `src/renderer/`. Le scelte del costruttore e
le decisioni del maintainer che reggono queste voci, ognuna col suo costo se
sbagliata, stanno in `ossatura-follow-ups.md` («Area 11a — minori aperti»);
le regole da scrivere prima del motore sono le §19 e §20 di quel file.

Spec: `docs/plans/2026-11-05-desktop-area11-product-docs-design.md`.
Piano: `docs/plans/2026-11-05-desktop-area11a-plan.md`.
Shape: `.impeccable/shape/{product-space,product-editor,product-comments-history}.md`.

## Le voci nuove

| Voce | Dove vive ora | Test |
|---|---|---|
| Lo spazio «Product» nei Docs (PRODUCT sopra CODE, la prima pagina radice in START HERE, l'indice dello spazio, lo spazio vuoto di un progetto nuovo) | `pages/productDocs/ProductSpace.tsx`, `ProductIndex.tsx`, `ProductPageRoute.tsx`, `ReadOnlyLine.tsx`; dati in `data/productDocs/reads.ts` (`getProductSpace`, `getProductPage`) | `pages/productDocs/ProductSpace.test.tsx` («ACQ: PRODUCT sopra CODE, col numero di pagine; la prima pagina radice apre START HERE», «VRD (nessun repository): solo PRODUCT, nessun CODE e nessun invito ad aggiungere un repository», «una lettura senza `product` (fixture, apposta): la pagina si disegna come prima»); `data/productDocs/productDocs.test.ts` («invisibile, inesistente o col modulo spento: null e not_found; visibile senza docs.view: forbidden») |
| L'albero delle pagine (sottopagine, rinomina, «⋯» con Move up / Move down / Indent / Outdent / Delete, trascinamento con linea d'arrivo, tastiera) | `pages/productDocs/ProductTree.tsx`; regole pure in `domain/productDocs/tree.ts`, `treeMoves.ts` | `pages/productDocs/ProductTree.test.tsx` («Features con quattro figlie; si chiude e si riapre», «Invio sul nodo apre la pagina», «Laura trascina «Bills» sopra «Sign-in»…»); `domain/productDocs/tree.test.ts` («rifiuta sé stesso e un discendente (anche un nipote)»); `treeMoves.test.ts`; `pages/productDocs/ProductSpace.focus.test.tsx` («1024: eliminata dalla barra, si apre il genitore e il fuoco va al suo titolo») |
| Il documento a blocchi (id stabili che non si riusano, operazioni `insert`/`set`/`delete`/`move`/`merge`, cambi per blocco) | `domain/productDocs/blocks.ts` (`applyBlockOps`, `blockChanges`, `makeBlockId`); scrittura in `data/productDocs/writes.ts` (`writeProductBlocksAs`, `saveProductBlocks`) | `domain/productDocs/blocks.test.ts` («dà id nuovi col prefisso blk-», «insert dopo null mette in testa, move dopo un id sposta»); `data/productDocs/productDocs.test.ts` («un insert con l'id di un blocco eliminato, anche di un'altra pagina, è block_id_taken») |
| Il testo coi segni (`RichText`: testo più intervalli di grassetto, corsivo e link; l'incolla; la ricerca che non legge gli indirizzi) *(maintainer, 5 nov 2026, Q2)* | `domain/productDocs/richText.ts` (`toggleMark`, `insertText`, `deleteRange`, `richFromHtml`, `safeLinkHref`, `richSegments`) | `domain/productDocs/richText.test.ts` («mette il grassetto, lo toglie, e lo fonde con uno vicino», «un intervallo vuoto non cambia niente», «togliere da una parte sola di un segno lo divide»); `data/productDocs/search.test.ts` («una parola in grassetto si trova, l'indirizzo di un link no; il passaggio non ha segni») |
| L'editor (`contenteditable` controllato per blocco, `beforeinput`, il menu «/», la barra della selezione, il campo del link, ⌘Z / ⇧⌘Z per pagina e per sessione, «Saving…» / «Saved», riprova) | `pages/productDocs/editor/*` (`BlockEditor.tsx`, `RichBlock.tsx`, `input.ts`, `keys.ts`, `undo.ts`, `SlashMenu.tsx`, `SelectionBar.tsx`, `LinkField.tsx`, `BlockHandle.tsx`, `useEditorSession.tsx`); voci di «/» in `domain/productDocs/shortcuts.ts` | `pages/productDocs/editor/BlockEditor.test.tsx` («Laura scrive in un paragrafo di Sign-in ed esce: un set con la sessionId dell'editor, «Saved»»); `input.test.ts` («insertText «x» a 3: il testo e il cursore a 4»); `keys.test.ts` («P41: Invio su un elemento d'elenco vuoto → toParagraph…»); `undo.test.ts` («un delete: un insert con lo STESSO id, al suo posto (i commenti tornano)»); `domain/productDocs/shortcuts.test.ts` |
| Immagini (incolla, trascina, 5 MB, didascalia, testo alternativo) | `pages/productDocs/editor/ImageBlock.tsx`, `images.ts`; il livello dati rifiuta un `src` che non sia `data:image/{png,jpeg,gif,webp};base64` ≤ 5 MB | `pages/productDocs/editor/images.test.ts` («un PNG di 10 KB diventa un data:image/png, col nome senza estensione come testo alternativo», «6 MB: too_large, senza leggerlo»); `MediaBlocks.test.tsx` («incollare un'immagine in Screens: un blocco dopo quello col fuoco, «Add a caption»…», «un'immagine di 6 MB: «This image is larger than 5 MB»…») |
| I file del Drive nelle pagine (la riga è un `DriveBlock`, il selettore riusa quello del Drive) | `pages/productDocs/editor/DriveBlock.tsx`, `DrivePicker.tsx`; apre con `useOpenDriveFile` | `pages/productDocs/editor/MediaBlocks.test.tsx` («INSERT ha Table, Image, Drive file, Link to… e Decision»; i casi del file nascosto: la riga «not available», senza nome né codice, R-G5) |
| Le decisioni (un blocco che cita una voce del registro decisioni, «decisione nascosta» identica a una inesistente) | `pages/productDocs/editor/DecisionBlock.tsx`, `DecisionPicker.tsx` | `pages/productDocs/editor/MediaBlocks.test.tsx` (i casi della decisione di un progetto che chi guarda non vede) |
| Le tabelle (celle coi segni, navigazione, la barra nelle celle, l'ancora di un commento sulla cella) | `pages/productDocs/editor/TableBlock.tsx`; celle in `ProductBlock` | `pages/productDocs/editor/BlockEditor.test.tsx` e `MediaBlocks.test.tsx` (i casi «/table» e Tab nelle celle); `pages/productDocs/comments/Comments.test.tsx` («in una cella di tabella: «Comment» sulla selezione, ancora = la cella») |
| I codici nel testo (`ACQ-3`, `ACQ-D7`…): un `CodeLink` per chi li legge, testo tenue per chi no | `pages/productDocs/editor/RichView.tsx`, `LinkPicker.tsx`; la regex è una sola, condivisa con la Chat (`CODE_IN_TEXT`) | `domain/productDocs/blocks.test.ts` («è la stessa regex dei codici della Chat e di Claude, non una copia»); `pages/productDocs/editor/MediaBlocks.test.tsx` («Link to…») |
| Commenti ancorati a un blocco o a una cella, risposte, «Risolto» / «Riapri», «Frase eliminata», la colonna dei commenti (che si apre da sola se la pagina ha fili aperti) | `pages/productDocs/comments/*` (`CommentsColumn.tsx`, `CommentThread.tsx`, `CommentComposer.tsx`, `CommentMark.tsx`, `SelectionCommentButton.tsx`), `SideColumn.tsx`; dati in `data/productDocs/comments.ts` | `pages/productDocs/comments/Comments.test.tsx` («Laura sceglie «only with Google» (in grassetto) → Comment → «@Mar» → Marco Bellini: il filo nella colonna…», «da tastiera: «⋮⋮» del blocco → Comment, con la frase intera»); `data/productDocs/comments.test.ts` («Sign-in ha un filo aperto di Laura che menziona Marco, con la risposta di Marco», «Bills ha un filo risolto da Laura; Phases un filo su un blocco che Matteo ha tolto») |
| Le menzioni (`@`) e la notifica **`product_doc.mention`** *(maintainer, 5 nov 2026, Q1)*: chi legge i Docs del progetto, mai chi scrive | `data/productDocs/comments.ts` (`productMentionCandidates`, la scrittura della notifica); resa in `notifications/NotificationItem.tsx` | `notifications/NotificationItem.productDoc.test.tsx` («in en: «Laura Costa mentioned you in ACQ-D<n> · Sign-in», il testo del commento, «Product»», «in it: «Laura Costa ti ha menzionato in ACQ-D<n> · Sign-in»», «la pagina rinominata: il titolo di adesso»); `data/productDocs/comments.test.ts` («Marco ha la notifica della menzione del seme») |
| I commenti seguono un'unione *(maintainer, 5 nov 2026, Q3)*: unendo due blocchi i commenti del secondo passano al blocco unito; «Frase eliminata» resta per un'ancora cancellata | `data/productDocs/writes.ts` (`onAnchorsMerged`), `domain/productDocs/blocks.ts` (`mergedFrom`) | `domain/productDocs/blocks.test.ts` (l'operazione `merge` e `mergedFrom`); `data/productDocs/comments.test.ts` (l'ancora dopo un'unione e dopo una cancellazione) |
| La cronologia (una revisione per sessione dell'editor, «Before» / «After», chi e quando; «Formatting changed») | `pages/productDocs/history/HistoryPanel.tsx`; dati in `data/productDocs/revisions.ts` (`listProductRevisions`, `touchedAfter`) | `pages/productDocs/history/HistoryPanel.test.tsx` («la riga di Marco del copione «Edited 1 sentence» con «Added», «After» e il testo…», «in italiano: «Ha modificato 1 frase»…»); `data/productDocs/revisions.test.ts` («due scritture della stessa sessione: una revisione, col primo before e l'ultimo after», «una scrittura di Marco in mezzo: tre revisioni, in ordine di seq») |
| Seguire una pagina («Follow» / «Following», «Followed by N people»): solo chi la crea e chi preme il bottone | `pages/productDocs/FollowButton.tsx`; dati in `data/productDocs/follows.ts` (`followProductPage`, `followersOf`, `productDocRecipients`) | `data/productDocs/productDocs.test.ts` («commentare o essere menzionati non fa seguire: segue solo chi crea e chi preme Follow»); `pages/productDocs/comments/Comments.test.tsx` («Sara su Bills: «Follow» → «Following»…», «chi segue e non è visibile a chi guarda non è nominato (R-G5)…») |
| La scrittura dal vivo (avatar, cursore con nome, «Marco Bellini is writing here», un copione di Marco che scrive e se ne va, il blocco tenuto) | `pages/productDocs/live/*` (`PresenceAvatars.tsx`, `RemoteCursor.tsx`, `RemoteBlockNote.tsx`, `presenceColor.ts`, `useSendPresence.ts`); dati in `data/productDocs/presence.ts` e `events.ts`, copioni in `data/seed/productDocs/presence.ts` | `pages/productDocs/live/Live.test.tsx` («Laura apre Meter reading: Matteo (legge) e Marco (scrive in Rules), mai lei…», «a metà copione: la barra di Marco con l'etichetta «Marco Bellini» nel paragrafo nuovo di «Rules»…»); `data/productDocs/presence.test.ts` («arriva in fondo: il paragrafo di Marco, una revisione, e Marco non c'è più», «a metà: Marco scrive in Rules, Matteo c'è senza scrivere; writersNear per sezione») |
| L'esportazione di una pagina o dello spazio in PDF e Word (il solo canale IPC nuovo, `file:save`) | `pages/productDocs/export/*` (`ExportMenu.tsx`, `PrintView.tsx`, `docx.ts`, `exportProduct.ts`); `domain/productDocs/exportModel.ts`; lettura in `getProductExport`; `platform/saveFile.ts`; processo principale in `src/main/index.ts`, `security.ts`, preload | `pages/productDocs/export/Export.test.tsx` («sulla pagina: THIS PAGE e WHOLE SPACE × PDF / Word, «9 pages, in tree order»…»); `export/docx.test.ts`; `domain/productDocs/exportModel.test.ts` («come Sara: AUD-8 resta testo (nessun link, nessun titolo), il file nascosto è «File: ACQ-F1 (not available)»…»); `data/productDocs/export.test.ts`; `main/security.test.ts` («file:save — parseSaveFileRequest»); `main/main.test.ts` («main e preload nominano solo i canali attesi, file:save compreso»); `platform/saveFile.test.ts` |
| La ricerca, ⌘K, il menu «#» e la chat del progetto (la fonte «from Product»; la chat di un repository senza le pagine di prodotto) | `data/productDocs/search.ts`; ⌘K in `palette/CommandPalette.tsx` (ambito «In Product»); la chat in `data/docs/chat.ts` (`docsAnswer`) | `data/productDocs/search.test.ts` (««readings 25th» come Laura e come Sara: Meter reading, col passaggio della frase», «la chat del progetto ACQ cita Meter reading, con la fonte «product»», «la chat del repository portale-utenti risponde dai suoi Docs e non cita le pagine di prodotto»); `palette/CommandPalette.product.test.tsx` (««bill»: solo pagine di prodotto, ambito «In Product»; Tab allarga…»); `pages/claude/conversation/MentionMenu.product.test.tsx`; `pages/docs/DocsChat.product.test.tsx` (««How do meter readings work?» nella chat di ACQ: cita Meter reading «from Product»») |
| Il modulo Docs per progetto (l'interruttore in Settings → General) *(maintainer, 5 nov 2026, Q4)*: spento, nasconde Docs e Prodotto e **tiene le pagine**; riacceso, ci sono | `data/projectSettings/general.ts` (`setDocsModule`, la voce di registro `project.docs_toggled`); la resa in General e in `pages/productDocs/ProductSpace.tsx` («Turn on Docs») | `data/productDocs/productDocs.test.ts` («Marco in ACQ: forbidden; spento e riacceso da Laura, le pagine ci sono»); `pages/productDocs/ProductSpace.test.tsx` («Giulia (gestisce MKX): «Turn on Docs» lo accende sul posto, e c'è lo spazio vuoto») |
| Il nome `product` riservato (un repository non può chiamarsi come lo spazio, e la categoria «Product» dei Docs dei repository diventa «Product overview» / «Panoramica di prodotto», P26) | `data/projectSettings/repositories.ts`; i18n `docs.kinds.product` | `data/productDocs/productDocs.test.ts` («il nome riservato»: «un repository chiamato «product» o «Product»: invalid: name_reserved») |
| L'istanza vuota (nessuno spazio Prodotto, ⌘K senza pagine di prodotto, nessun copione) | `data/auth/emptyInstance.ts` (invariato: lo stato vuoto non ha pagine) | `emptyInstance.test.tsx` («la doc di prodotto è vuota: nessuno spazio, ⌘K senza pagine di prodotto, nessun copione») |
| Il seme di ACQ (nove pagine, due PNG, fili aperti e risolti, un filo su un blocco tolto, i copioni) | `data/seed/productDocs/*`, `assets/productDocs/*.png` | `data/seed.11a.test.ts` («ha nove pagine: Features con quattro figlie, il resto alla radice», «ogni pagina ha una revisione `create`…», «le modifiche sono di Laura, Marco e Matteo, e i `seq` sono distinti e crescono con la data») |

## Per il prodotto vero

Il prototipo ha dati finti e nessuna rete: il motore deve dare al web e
all'app ciò che qui è un livello dati in memoria. La lista, con il costo di
ciascuna scelta, sta in `ossatura-follow-ups.md`; qui l'elenco di ciò che
manca sul server di oggi.

1. **Le tabelle** (migrazione Drizzle, una per cosa):
   - le **pagine di prodotto** (`project_id`, `parent_id`, `order`, codice
     della serie `-D` **condivisa** con i Docs dei repository, titolo, il
     **corpo** come documento a blocchi con id stabili, `updated_at`);
   - le **revisioni** (una per sessione dell'editor: autore, `before` e
     `after` per blocco, `seq` monotono, `last_seq`, `session_id`);
   - i **commenti** (`page_id`, `anchor_id`, la frase citata, `parent_id`,
     `resolved_at`; il testo di un commento eliminato non esiste più, come
     per quelli dei ticket);
   - i **seguaci** (`page_id`, `user_id`).
   Il corpo può essere un `jsonb` con id stabili per blocco e per cella, o
   righe per blocco: la scelta vincolante è che **l'id di un blocco non si
   riusa mai**, anche dopo un'eliminazione (vedi §19). Un progetto
   eliminato porta con sé pagine, revisioni, commenti e seguaci (il
   prototipo lo fa in `data/projectSettings/purge.ts`, con una chiave
   `pageId`).
2. **Il testo coi segni** (`RichText`): testo più intervalli `{from, to, type}`
   di grassetto, corsivo e link, **mai HTML salvato**. Gli `href` si
   validano **anche sul server** (solo `http:` e `https:`): nel prototipo la
   regola sta in `safeLinkHref` nel renderer e in `isExternalOpenAllowed` nel
   processo principale; sul server va una terza copia con la stessa tabella
   di casi (`main/security.test.ts` è il modello), perché il server è
   l'ultima difesa prima che un indirizzo diventi un link cliccabile per
   altri.
3. **Il canale in tempo reale** che il server **non ha**: la presenza (chi è
   nella pagina, dove scrive) e l'avviso «la pagina è cambiata» passano oggi
   da `data/productDocs/events.ts`. Serve un canale per pagina (SSE o
   WebSocket: il server oggi ha solo SSE per le sessioni degli agenti, che
   non è per pagina e non è bidirezionale), con i permessi calcolati dal
   server a ogni evento. Nessuno scrive in presenza senza `docs.edit`.
4. **L'esportazione** lato client (come nel prototipo: `printToPDF` di
   Electron e `docx` nel renderer) **oppure** lato server. Per il web serve
   una scelta nuova: senza Electron il PDF è `window.print()` (nessun esito
   da mostrare) e il Word va costruito nel browser o sul server.
5. **La dipendenza `docx`** (`apps/desktop`, `docx@9.15.2`) e
   **`docx>@types/node`** → `25.9.2` fra gli `overrides` di pnpm nella radice
   (`package.json`): `docx` dichiara `@types/node ^26` fra le sue
   `dependencies`, e senza l'override pnpm avrebbe risolto di nuovo i peer
   opzionali di altri workspace (vite, vitest, astro, changesets). Chi porta
   `docx` sul server o sul web tenga l'override, o il lockfile cambia in
   pacchetti che non c'entrano.
   L'override fissa `@types/node` a `25.9.2`, **fuori dall'intervallo
   `^26.6.2`** che `docx@9.15.2` dichiara: sono solo tipi (il renderer non usa
   i tipi di Node, typecheck verde), ma **va tolto quando il monorepo passa a
   `@types/node` 26**.
6. **`product_doc.mention`** *(maintainer, 5 nov 2026, Q1)*: un
   `notification_kind` nuovo nello schema condiviso (`packages/shared`,
   `packages/db`).
   - **Rollback**: finché ne esistono righe **non si scende d'immagine sul
     server** (500 su `/api/inbox`, come per ogni `notification_kind` nuovo);
     la voce di deploy-log lo dice e indica la pulizia
     (`delete from notifications where kind = 'product_doc.mention'`, dopo
     aver contato le righe), e il caddy scende insieme al server.
   - **Cambi additivi verso l'app**: il valore nuovo dell'enum arriva come
     `UNKNOWN` ai client vecchi grazie a `readerSchema`; ogni campo nuovo
     della card (nel prototipo `AppNotification.productComment`, con
     `pageId` e `rootId`) nasce **facoltativo**, mai obbligatorio; il titolo
     («… ti ha menzionato in ACQ-D<n> · <titolo>») e il corpo si **derivano a
     lettura** dalla pagina di adesso, mai dal jsonb dell'evento (una pagina
     rinominata o eliminata, `objectGone`, vale per le card vecchie come per
     le nuove); e la fixture del test dell'app **senza** i campi nuovi c'è
     apposta (CLAUDE.md, «Verso l'app mobile, solo cambi ADDITIVI»; sul web,
     difendere il campo nel punto di lettura).
   - Va ricordato che il 11b aggiunge altri due `notification_kind`
     (`product_doc.updated`, `product_doc.question`): ciascuno con la sua
     regola di rollback.
7. **Il worker**: nessun lavoro del 11a gira sul worker (le revisioni si
   scrivono nella richiesta di chi salva). Il 11b ne avrà uno: le modifiche
   di Claude sulle pagine, per conto di una fonte.
8. **Il permesso** `docs.view` / `docs.edit` si calcola sul server nella
   WHERE (`docs/invariants/permissions.md`): un progetto o una pagina
   invisibile risponde 404 `not_found`, come una che non esiste; un
   progetto con il modulo Docs spento risponde allo stesso modo.
9. **Cosa NON c'è sul server e il prototipo mostra come intenzione**: la
   modifica e l'eliminazione dei commenti, «Ripristina» nella cronologia e
   un avviso di modifiche non salvate all'uscita: stanno fra i minori
   aperti, con la loro scelta.
