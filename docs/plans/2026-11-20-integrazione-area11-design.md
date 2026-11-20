# Integrazione area 11 — la documentazione di prodotto: design

*20 nov 2026, 72. Dall'inventario
(`docs/plans/2026-11-19-integrazione-area11-inventario.md`, branch
`docs/area11-inventario`, 9a8904836 + 5dd692588) e dalle decisioni girate da
46 lo stesso giorno. La specifica resta il prototipo col suo design
(`docs/plans/2026-11-05-desktop-area11-product-docs-design.md`, piani
`…-area11a-plan.md` e `2026-11-06-desktop-area11b-plan.md`). Dove una
decisione lo cambia, il prototipo si riallinea PRIMA di integrarlo (94): lo
dice la sezione. Le invarianti nuove sono in fondo, scritte per esteso, e le
applica 46 quando approva questo design. Niente codice qui.*

*Il codice parte da `feat/integrazione-area10` (42af26465, con i renderer di
94). L'area 11 nell'app non ha niente: nessun adattatore, nessuna rotta,
nessuna tabella. Si costruisce da zero, a fette, ognuna accesa solo quando il
server la regge.*

## Le decisioni *(20 nov 2026)*

| | Decisione | Chi |
|---|---|---|
| D-1 = a | Il corpo è un documento a blocchi con id stabili, scritto a **operazioni** (`set`, `insert`, `delete`, `move`, `merge`) con la sessione dell'editor. | 46 |
| D-2 = **a** | **La scrittura dal vivo, per pagina**: un canale in tempo reale con presenza, cursori, blocchi nuovi e «X sta scrivendo qui» per sezione. | **maintainer** |
| D-3 = a | Le immagini nell'archiviazione dell'istanza (S3), il blocco tiene il riferimento. | 46 |
| D-4 = a | L'esportazione si compone nel client (`printToPDF` nel desktop, la stampa del browser sul web, `docx` nel renderer), su una lettura apposta del server. | 46 |
| D-5 = **a** | **Claude legge una fonte appena arriva**, con un lavoro del worker sotto la quota e la pausa della coda; ciò che resta indietro lo riprende il giro notturno. A richiesta anche dal riquadro. | **maintainer** |
| D-6 = **b** | **Le notifiche della doc stanno nel catalogo degli avvisi**: Preferenze → Notifiche le elenca, con App e Telefono. Il prototipo si riallinea. | **maintainer** |
| D-7 = a | Finché il server non c'è, la rotta dello spazio sta dietro una funzione spenta e dice «Coming soon». | 46 |
| D-8 = a | La parità di ciò che fa Claude si misura sull'esito, con golden del modello vero; i wireframe si provano a mano. | 46 |
| D-9 = a | La serie `-D` condivisa: `doc_page_codes` guadagna `product_page_id` (uno dei due con `repository_id`, CHECK) e un trigger gemello. | 46 |
| D-10 = a | L'origine «dalla doc» di una richiesta è un campo additivo, `productOrigin` (nullable, default null), accanto a `origin`. | 46 |
| D-11 = a | Il corpo in un `jsonb` per pagina, più una sequenza di id per pagina; le revisioni a parte; le operazioni sotto un `FOR UPDATE` della pagina. | 46 |
| D-12 = a | Le pagine di prodotto NON scrivono nel registro delle modifiche: la cronologia della pagina è la sua storia. | 46 |

## I fatti del codice che reggono il design

Si aggiungono a quelli dell'inventario (lato server), e non li ricopio.

- **Le migrazioni dell'area partono dalla 0202.** L'area 10 si è fermata alla
  0201. Ogni fetta prende il primo numero libero al momento del commit, con
  `when` crescente (la regola di sempre).
- **Il catalogo degli avvisi ha già la famiglia `docs`** (`docs.release_note`,
  `docs.nightly_attention`, `packages/shared/src/alerts/catalog.ts`). Le tre
  righe della doc di prodotto entrano lì (D-6 = b), coi loro motivi
  obbligatori, e in `LIVE_ALERT_TYPES` solo quando il loro produttore c'è.
  Il test di parità del catalogo pretende il `notification_kind` per ogni tipo
  vivo.
- **Il canale in tempo reale si appoggia su ciò che c'è**: l'SSE delle
  sessioni (`GET /api/agent-sessions/:id/stream`) col `NOTIFY` di Postgres
  (`AGENT_SESSION_EVENTS_CHANNEL`) è il modello. Un SSE è a una via: presenza
  e cursori arrivano dal client con `POST` brevi, e il server li ripete agli
  altri. Caddy fa già da proxy agli stream SSE del server (nessuna rotta nuova
  in caddy).
- **Il worker ha il giro notturno, la coda che riprende e il runner che conta
  i consumi.** Il lavoro della doc nasce con il suo `UsageTag`
  (`TrackingAgentRunner`: modello e consumo in UN posto), sotto il serializer
  per progetto, e passa da `held` quando la quota o il budget lo fermano.
  `heldReasonSchema` resta com'è: la riga «riprende quando il budget torna»
  per pagina si legge dalla coda della doc, non dal job.
- **Le fonti hanno già il loro punto d'arrivo**, e ognuno dice a quale
  progetto appartiene: la posta ammessa e attribuita (il poller Google,
  `email_proposals`), le riunioni (`meeting_notes`), il registro decisioni,
  la chiusura di una task, il rilascio. Il lavoro della doc si accoda lì, nella
  stessa transazione della fonte, come gli eventi delle automazioni.
- **Il registro decisioni non è mai scritto dall'AI**
  (`decisions-never-ai.test.ts`). Una decisione è una FONTE della doc, mai
  un suo bersaglio: il lavoro della doc non importa niente che scriva nel
  registro, e un test sul sorgente lo fissa (il gemello di
  `neverWritesDecisions.test.ts` del prototipo).
- **Il ponte della chat ha l'allowlist e la regola dei lettori.** Le letture
  di Claude sulla doc (le pagine, i cambi della settimana) entrano come tool
  della chat, con la loro rotta nell'allowlist del token e la proiezione nel
  ponte. Il contenuto dei tool non arriva a chi non è l'autore
  (`claude-actions.md`, review dell'area 10), e il testo di una pagina NON è
  contenuto fidato: lo scrive chiunque abbia `docs.edit`, come le pagine
  manuali dei Docs (`CHAT_TOOL_UNTRUSTED_ROUTES`).

## Le fette

Sei fette, nell'ordine in cui si accendono. Ognuna ha il suo piano, e il suo
lato renderer (le R11-n dell'inventario) che 94 integra dopo il server.

### F1 — Lo spazio e l'editor (S11-1, R11-1; D-1, D-3, D-7, D-9, D-11, D-12)

**Cosa vede chi usa l'app**: la card Product nella Home dei Docs, l'albero
delle pagine, l'indice, l'editor a blocchi, la cronologia con «Undo», Segui.
Prima di F1 l'indirizzo dice «Coming soon» (D-7, lavoro di 94 che si può
fare subito).

- **Le tabelle** (una migrazione):
  - `product_pages`: progetto, padre, ordine fra i fratelli, titolo, corpo
    `jsonb` (i blocchi, D-11), `block_seq` (la sequenza degli id: un id non
    si riusa mai, nemmeno di un blocco tolto), chi e quando ha creato e
    aggiornato. Il `FOR UPDATE` della pagina serializza le operazioni.
  - `product_page_revisions`: una per sessione dell'editor (`session_id`,
    `seq`, `last_seq`), coi cambi per blocco (prima e dopo, le ancore
    toccate, `merged_from` del solo `merge`), `kind` (`edit` | `undo`),
    `undo_of`, l'autore, e da F5 la fonte e il `via`.
  - `product_page_follows (page_id, user_id)`.
  - `doc_page_codes` con `product_page_id` (D-9): `repository_id` diventa
    nullable, una CHECK «uno dei due», un trigger sulle pagine di prodotto
    che dà il codice dalla stessa serie per progetto. Il nome di repository
    `product` diventa riservato (la regola del prototipo).
- **Le rotte**, tutte con `config.access` di progetto (`docs.view` per
  leggere, `docs.edit` per scrivere), invisibile = 404, archiviato come
  inesistente (`projectPermissionsFor` lo esclude, salvo le eccezioni
  dichiarate con `config.archived`), elenchi filtrati nella WHERE:
  - lo spazio (albero, recenti), una pagina, crea, rinomina, sposta
    (padre e ordine, senza cicli), elimina (spento su una pagina con figlie,
    come il prototipo);
  - `POST …/pages/:id/ops { sessionId, baseSeq, ops, undoOf? }`: applica le
    operazioni sotto il `FOR UPDATE`, valida id (esistenti, mai riusati),
    `href` (solo `http(s)`, la stessa tabella di casi dei Docs e della chat:
    tre copie oggi, una sola funzione condivisa da qui), riferimenti a Drive,
    decisioni e wireframe con la visibilità di CHI SALVA; scrive o allunga
    la revisione della sessione;
  - le revisioni, con lo stato di «Undo» calcolato dal server per chi guarda,
    e `POST …/revisions/:id/undo` (una revisione nuova, `kind: "undo"`);
  - seguire e smettere;
  - le immagini (D-3): caricamento nell'archiviazione d'istanza (come gli
    allegati, tetto 5 MB, mai SVG), il blocco tiene la chiave; la lettura
    passa dalla rotta, coi permessi della pagina. `storageKeysOf` le impara,
    o l'eliminazione di un progetto le lascia orfane sul volume.
- **Le operazioni stanno in `@stubwise/shared`** (`applyBlockOps`, la regola
  del prototipo): la stessa funzione per il server (che salva) e il client
  (che anticipa). Un client vecchio non c'è: la doc nasce adesso.
- **Fuori**: commenti (F2), ricerca ed esportazione (F3), dal vivo (F4),
  Claude (F5, F6).

### F2 — Commenti, menzioni e le notifiche nel catalogo (S11-2, R11-2; D-6)

**Cosa vede chi usa l'app**: i fili ancorati a un blocco o a una cella, con la
frase citata, le risposte, le @menzioni, «Resolve»/«Reopen», «Sentence
deleted»; le card in inbox; le righe della doc in Preferenze → Notifiche.

- `product_comments`: pagina, ancora (blocco o cella), frase citata (≤200),
  il filo (padre), il testo, autore, `resolved_at`, e la regola dei commenti
  dei ticket da subito: eliminare scrive `body = ''` con una CHECK
  (`deleted_at IS NULL OR body = ''`). Modificare ed eliminare un commento
  non c'è nel prototipo (minore aperto): le colonne ci sono, le rotte no.
- Commentare chiede `docs.edit`, come il prototipo.
- **Le tre righe nel catalogo (D-6 = b)**, famiglia `docs`, ognuna col suo
  `notification_kind` (tre `ALTER TYPE … ADD VALUE`, ognuno in uno statement
  a sé, nessuno usato nello stesso batch):
  - `product_doc.mention`: solo obbligatoria (`mandatoryOnly`), motivo nuovo
    `mentioned`; nessuna iscrizione;
  - `product_doc.updated` (da F5) e `product_doc.question` (da F5):
    iscrizione con `docs.view`, accese di partenza per chi ha `docs.edit`
    (la regola del prototipo: «altrimenti chi ha `docs.edit`»), più il
    motivo obbligatorio `follower`: chi segue la pagina le riceve sempre.
    Mai Claude, mai chi ha agito (`exclude` del produttore).
  - Entrano in `LIVE_ALERT_TYPES` solo con il loro produttore: `mention` in
    F2, le altre due in F5.
- Il prototipo si riallinea: le tre righe nel suo catalogo
  (`domain/alerts/catalog.ts`), e `productDocRecipients` diventa quella dei
  motivi obbligatori più le iscrizioni. Vedi [DECIDE] N-1.
- I campi della card si DERIVANO a lettura, `objectGone` compreso
  (CLAUDE.md): il titolo della pagina, il codice, chi ha menzionato.

### F3 — Ricerca, citazioni, esportazione (S11-3, R11-3; D-4)

**Cosa vede chi usa l'app**: ⌘K con «In Product», le pagine di prodotto nella
chat dei Docs, «Esporta» in PDF e Word.

- I chunk delle pagine di prodotto in una tabella a parte,
  `product_page_chunks`, con lo stesso chunking e lo stesso embedder dei
  Docs (*corretto col piano di F3*: `doc_chunks` ha `page_id → doc_pages` e
  `repository_id` NOT NULL, e il retrieval filtra per repository e
  generazione). Gli embedding li fa il SERVER, come già per le pagine manuali
  (`embedManualPage`): un poller rifà ogni 30 s le pagine ferme da almeno
  30 s (`embedded_at < updated_at`), fail-open.
- La ricerca ibrida (`retrieveChunks…`) impara l'ambito Product; le
  citazioni `doc` della chat dei Docs (`chat/citations.ts`) le pagine di
  prodotto; la chat dei Docs del progetto le legge come contenuto NON fidato
  (le scrive chi ha `docs.edit`).
- L'esportazione (D-4 = a): `GET …/pages/:id/export` e quella dello spazio,
  i blocchi senza i commenti, i wireframe come immagine (dal server, ripuliti),
  le immagini con un URL firmato breve. Il file lo compone il client: niente
  `docx` nell'immagine del server.

### F4 — La scrittura dal vivo (S11-4, R11-4; D-2 = a)

**Cosa vede chi usa l'app**: gli avatar di chi è sulla pagina, i cursori degli
altri, «X sta scrivendo qui» sulla sezione, i blocchi degli altri che
compaiono senza ricaricare.

- `GET /api/product-pages/:id/live` (SSE): le revisioni nuove (con `seq`, per
  riallinearsi), presenza, cursori, sezioni prese. I permessi si
  ricalcolano a OGNI evento mandato (un accesso revocato chiude lo stream),
  come la regola della revoca a lettura.
- `POST …/live/presence { cursor, sectionId? }`: un battito breve (qualche
  secondo), in memoria del server con una scadenza, mai in tabella; più
  server dietro caddy non ci sono oggi, e la voce di deploy lo dice.
- **La sezione presa**: chi scrive in una sezione (un titolo e i blocchi fino
  al titolo dopo) la tiene finché scrive, più una breve coda. Gli altri la
  vedono come «X sta scrivendo qui» e il server rifiuta le loro operazioni su
  quei blocchi (409 `section_busy`, mai una sovrascrittura silenziosa). È la
  regola del prototipo, e serve anche a Claude (F5: aspetta chi scrive nella
  stessa sezione). Fuori dalla sezione presa le operazioni si applicano in
  ordine d'arrivo sotto il `FOR UPDATE`: gli id stabili (D-1) le rendono
  sicure.
- Un client che resta indietro (`baseSeq` vecchio) riceve 409 con le
  revisioni mancanti e riapplica: niente fusione di testo dentro un blocco
  (fuori dal prototipo).

### F5 — Claude dalle fonti e le domande (S11-5, R11-5; D-5 = a, D-8)

**Cosa vede chi usa l'app**: il segno di Claude nel testo con la fonte,
«Looks good», «Undo»; le domande ancorate con «Update it» / «Keep as is» /
«Open a request»; le domande in Home «Decide» e nel riquadro; le card
`product_doc.updated` e `.question`; la riga «riprende quando il budget
torna» sulla pagina.

- **Il lavoro** (D-5 = a): `product_doc_jobs`, accodato nella transazione
  della fonte (email ammessa e attribuita, riunione pronta, decisione
  registrata, task chiusa, rilascio), una riga per fonte e progetto. Il
  worker lo prende sotto il serializer per progetto, con la quota e la pausa
  della coda: se una delle due lo ferma, il lavoro resta in coda e il giro
  notturno lo riprende. A richiesta dal riquadro («aggiorna <pagina> da
  questa email»), come `manual`.
- **Il modello propone, la regola decide** (D-8):
  - il modello legge la fonte e le pagine del progetto e restituisce FATTI
    strutturati (la forma `ProductFact` del prototipo: pagina, ancora,
    cambio, chiarezza, il testo che si aspetta di trovare), mai testo libero
    da incollare;
  - `decideFact` va in `@stubwise/shared` (una regola per worker, server e
    client) e decide: scrivere, chiedere (vago, contraddice una persona o il
    testo, diverge da ciò che è fatto, chi porta la fonte non ha i permessi)
    o lasciar stare;
  - il server ricontrolla il risultato (le ancore esistono, il testo atteso
    c'è ancora, la sezione non è presa), poi scrive una revisione per fonte e
    pagina col `via: "claude"` e l'autore = il titolare della fonte.
- **I segni** (`product_claude_marks`): la revisione, l'ancora, la fonte, lo
  stato (`open` | `looks_good` | `undone`). La vista della fonte la calcola
  il server per chi guarda: chi non può aprire la fonte legge «da un'email di
  <titolare>» senza oggetto né testo (§21 del prototipo, la famiglia di
  `mailbox_owner`). Vedi [DECIDE] N-2.
- **Le domande** sono commenti di Claude con la loro parte di domanda
  (`ProductQuestion`): una vista per chi legge (mai `sourceRef` grezzo), la
  risposta UNA volta, «Update it» come revisione, «Open a request» con
  `productOrigin` (F6, D-10).
- **Il budget del mese esaurito o la coda in pausa**: niente lavoro nuovo;
  la pagina dice che riprende (la riga del prototipo).
- **Golden** (D-8 = a): per ogni fonte del seme, scrive / chiede / lascia
  stare, col segno e la fonte giusti; più gli ostili (un'email che chiede di
  riscrivere tutta la doc, una riunione che nomina un'altra pagina).

### F6 — Prima versione, wireframe, backlog, il catalogo di Claude (S11-6, R11-6; D-10)

**Cosa vede chi usa l'app**: «Write the first version with Claude» in uno
spazio vuoto, «Draw this screen», «Propose backlog items», «From this page»
e «From the doc», le sei voci di Claude nel riquadro, la card Product e la
riga dello Stato dell'istanza.

- **La prima versione**: un lavoro interrompibile, una pagina alla volta, con
  le fonti scelte da chi lancia e VISTE da lui (la posta solo sua); «Accept
  this page» e «Undo the first version» solo se nessuno le ha toccate.
- **I wireframe**: li disegna il modello; lo SVG si ripulisce sul server
  (niente script, niente riferimenti esterni, niente `foreignObject`) prima di
  salvarlo e di esportarlo come PNG. Si provano a mano (D-8).
- **Il backlog da una pagina**: `createRequest` in blocco con
  `productOrigin: { pageId, pageCode, anchorId, questionId } | null`
  (D-10, additivo, `.nullable().default(null)` con il suo test di parse
  senza il campo); «From this page» è una lettura delle richieste nate dalla
  pagina, filtrata nella WHERE.
- **Le sei voci del catalogo** (`writeFirstVersion`, `undoFirstVersion`,
  `updateProductPage`, `undoProductUpdate`, `drawWireframe`,
  `deleteWireframe`) con le classi del prototipo, le funzioni in `services/`,
  il permesso `docs.edit`, e `claude-actions-effects.test.ts` nel giro. Le
  capacità `product*` di S0 (rimandate dall'area 10, F7-1 = a) si accendono
  qui, una per voce che passa.
- **Le letture per il modello**: le pagine del progetto e i cambi della
  settimana, come tool della chat con l'allowlist del ponte, contenuto non
  fidato.
- **Lo Stato dell'istanza**: un `kind` nuovo nelle sue righe per il lavoro
  della doc (in coda, fermo per quota o budget).

## [DECIDE] (solo ciò che cambia ciò che si vede)

- **N-1 — «Segui» e Preferenze → Notifiche, ora che le notifiche stanno nel
  catalogo (D-6 = b).** Il prototipo ha solo «Segui» per pagina; il catalogo
  ha le righe per progetto.
  - **(a) — consigliata.** Tutte e due: la riga del progetto in Preferenze
    (`product_doc.updated`, `.question`) decide per tutte le pagine, accesa
    di partenza per chi ha `docs.edit`; «Segui» su una pagina la fa arrivare
    SEMPRE, anche con la riga spenta (motivo obbligatorio `follower`). Le
    menzioni arrivano sempre, e non hanno riga da spegnere. Si vede così: chi
    non vuole le card di un progetto le spegne in Preferenze, e chi vuole una
    pagina sola la segue.
  - (b) La riga di Preferenze comanda su tutto, anche su «Segui»: «Segui»
    diventa solo «voglio sapere di questa pagina» quando la riga è accesa.
  - (c) Niente «Segui»: la riga di Preferenze e basta. Il prototipo perde un
    bottone.
- **N-2 — Quali email possono scrivere nella doc.** La doc la legge chiunque
  abbia `docs.view` nel progetto; una email è di chi la riceve
  (`mailbox_owner`, mai gli admin).
  - **(a) — consigliata.** Come il prototipo: solo le email già ammesse e
    attribuite al progetto (quelle che oggi diventano proposte), con l'autore
    della modifica = il titolare della casella e la fonte, per chi non la può
    aprire, ridotta a «da un'email di <titolare>» (niente oggetto né testo).
    Il fatto entra nella doc; la email no.
  - (b) Come (a), ma ogni email chiede al titolare un sì («usa per la doc»)
    prima che Claude la legga: più controllo, la doc più lenta e una card in
    più per ogni email.
  - (c) Le email fuori dalle fonti: la doc la aggiornano riunioni,
    decisioni, task e rilasci.

## Ruling (decisi qui, costano poco se sbagliati)

- **La sezione presa rifiuta (409), non fonde** (F4): è la regola del
  prototipo; fondere il testo dentro un blocco è un'altra area.
- **La presenza in memoria del server**, non in tabella (F4): sparisce con
  un riavvio, e un battito la rimette.
- **I chunk in una tabella a parte** (F3, corretto col piano): `doc_chunks`
  è legata ai Docs dei repository; la ricerca unisce le due sorgenti, e la
  citazione resta `doc` con un campo additivo `product`.
- **La sezione presa sta in tabella** (F4, dal piano): presenza e cursori in
  memoria, ma la presa la deve vedere anche il worker (F5).
- **Il modello restituisce fatti strutturati, mai testo da incollare** (F5):
  è ciò che rende `decideFact` applicabile e la parità misurabile.

## Le invarianti nuove (per esteso; le applica 46)

- **Una modifica di Claude alla doc passa dalla regola, non dal modello.**
  Il modello propone fatti; `decideFact` (in `@stubwise/shared`, una sola
  copia) decide se scrivere, chiedere o lasciar stare, e il server ricontrolla
  ancore, testo atteso e sezione presa prima di scrivere. Chi aggiunge una
  fonte la aggiunge alla coda della doc, non al prompt.
- **La doc non scrive mai nel registro decisioni**, e il lavoro della doc
  non importa niente che lo faccia: un test sul sorgente, come
  `decisions-never-ai.test.ts`.
- **La fonte la vede chi la può aprire.** Il segno e la domanda portano la
  fonte calcolata dal server per chi guarda; una email per chi non è il
  titolare è solo «da un'email di <titolare>».
- **Le operazioni sono l'unica scrittura del corpo.** Nessuna rotta scrive
  il `jsonb` intero; un id di blocco non si riusa mai (la sequenza per
  pagina), salvo lo stesso blocco che torna con `undoOf`.
- **Il canale dal vivo ricalcola i permessi a ogni evento**: un accesso
  revocato chiude lo stream; presenza e cursori non si scrivono mai in
  tabella (la sezione presa sì, con scadenza: la legge anche il worker).

## Rollback, per fetta (le voci di deploy-log le scrive ogni piano)

- F1, F3, F4, F6: tabelle e colonne nuove, un server vecchio le ignora.
  `doc_page_codes.repository_id` nullable: un server vecchio legge le righe
  coi repository; le righe delle pagine di prodotto non le vede.
- F2, F5: tre `notification_kind` nuovi. **NON sicuro** scendere sul server
  finché ne esistono righe (500 su `/api/inbox`): la voce dà le query.
- F6: `productOrigin` additivo; le voci nuove del catalogo un server vecchio
  le rifiuta come `fn` ignote.

## Per 94 (renderer)

- D-7 si può fare subito: la rotta dello spazio dietro `product-space`,
  spenta, «Coming soon».
- D-6 = b riallinea il prototipo: le tre righe nel catalogo degli avvisi del
  prototipo, `productDocRecipients` sui motivi obbligatori (N-1).
- Ogni R11-n si accende dopo la sua F: lo spazio con F1, `product-docs` con
  F5.
