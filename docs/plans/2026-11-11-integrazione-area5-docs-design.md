# Integrazione area 5 — Docs e Drive — design (11 nov 2026)

> Autore: stubwise-72 (server e worker); il renderer è di stubwise-94.
> Decisioni dell'11 nov 2026 qui sotto («Decisioni»); il piano della F1 è
> `docs/plans/2026-11-11-integrazione-area5-fetta1-plan.md`.
> Branch: `feat/area5-docs-server`, da `feat/integrazione-area4` (a9ad4556).
>
> **Specifica**: il prototipo.
> - Design: `docs/plans/2026-10-25-desktop-area5-docs-drive-design.md`, con il suo piano.
> - Parità: `apps/desktop/docs/area5-parity.md`.
> - Decisioni R-H1…R-H5: `apps/desktop/docs/ossatura-follow-ups.md` («Area 5»).
> - Shape: `apps/desktop/.impeccable/shape/{docs,drive,drive-google,drive-search}.md`.
> - Dati: `apps/desktop/src/renderer/data/{docs,drive}/`, tipi in `data/model.ts`.
>
> Registro, area 5: «Docs del progetto e Drive (sezioni «in arrivo»); modulo
> Docs dei progetti». Rimandi delle altre aree che puntano qui:
> - le citazioni di file del repo e del Drive (area 4, fette 2 e 4);
> - il link delle citazioni di pagine Docs, che nel desktop oggi non ha destinazione (`integration-area4.md`);
> - «Save to Drive» dalla Chat (area 4: gli allegati non entrano da soli nel Drive);
> - la pagina Docs intera, che i tool di Claude non leggono (registro, «Limiti della fetta 1»).

## Cosa c'è già e cosa no

**Docs: c'è quasi tutto, ma per REPOSITORY.**
- Le tabelle: `doc_pages`, `doc_chunks` (pgvector, bge-m3), le generazioni, il giro notturno.
- Le rotte per repository (`routes/docs.ts`, `docs-chat.ts`):
  - albero, pagina, highlights, brief, export zip;
  - generazione e ripresa, stato;
  - pagine manuali (`docs.edit`, solo `kind manual`);
  - chat RAG.
- Le rotte per progetto (`routes/project-docs.ts`): spazi, highlights, ricerca ibrida e chat RAG.
- Il grafo (`routes/repo-graph.ts`), la ricerca globale (`/api/search`, gruppo docs, e `docs-semantic`).
- I permessi `docs.view` (tutti i preset), `docs.edit` (Lead, Developer, Legacy Member) e `docs.generate` (Lead, Developer).
- Il modulo `docs` di progetto (`PROJECT_MODULES`) c'è, e il desktop lo segue già.

Il maintainer ha deciso che i Docs arrivano «come oggi», senza funzioni nuove. Restano dei buchi rispetto al prototipo:
1. **I codici `<PRJ>-D<n>` non esistono.** L'id di una pagina generata cambia a ogni rigenerazione (righe nuove, le vecchie potate). Le citazioni della Chat salvano `doc_pages.id`, quindi oggi si ROMPONO alla prima rigenerazione.
2. **Le pagine manuali e le note di rilascio non hanno embedding.** La ricerca semantica e la chat RAG le trovano solo per testo.
3. **I tool di Claude cercano nei Docs ma non leggono una pagina intera.** Nell'allowlist del turno c'è solo `docs/search`.
4. **`@stubwise/api-client` è incompleto per i Docs.** Mancano il CRUD manuale, generazione, ripresa e stato, l'export e lo streaming SSE.
5. **La citazione di una pagina** arriva al client senza repository né slug: il desktop non sa dove portarla.

**Drive: NON esiste.** Non ci sono tabelle, rotte, permessi `drive.*` né chiamate alle API di Google Drive. Gli scope OAuth di oggi (`packages/google/src/oauth.ts`) sono `openid`, `email`, `gmail.readonly` e `calendar.readonly`. Gli unici archivi di file sono i due allegati su S3: ticket (`tickets/…`) e Chat (`chat/…`). Del Drive si riusano:
- lo storage, col caricamento multipart e il download firmato degli allegati della Chat;
- `@stubwise/embeddings` e lo schema di retrieval dei Docs;
- il `TrackingAgentRunner` del worker per i riassunti.

## Perimetro (dal prototipo)

1. **Docs del progetto (modulo).**
   - Home: identità dal brief, «Start here», spazi, decisioni in sintesi, novità, chat di progetto.
   - Spazio del repository: indice, albero in quattro gruppi, pagina, pagina manuale, brief, release, grafo, ricerca, chat.
   - In ⌘K la ricerca resta nello spazio, e Tab la allarga.
   - Codici `D` stabili.
2. **Drive del progetto** (sempre presente, non è un modulo), e la destinazione globale `#/drive`.
   - Due sorgenti in un elenco solo: file CARICATI (anteprima in Stubwise) e riferimenti GOOGLE (si aprono in Google).
   - Codici `<PRJ>-F<n>`.
   - Filtri e ordinamento: «Più usati» per aperture in 90 giorni, con una deduplica di 30 minuti per persona.
   - Pannello di dettaglio: storia delle aperture con `drive.history`.
   - File nascosti visibili solo a `drive.manage`; un file invisibile è come uno che non esiste (R-G5).
3. **Contenuto dei file**: estrazione del testo e riassunto AI di 2–3 frasi.
   - Ricerca per contenuto, con il passaggio evidenziato.
   - Gli stati processing, ready, no_text, unsupported ed error, con «Riprova».
4. **Chat.**
   - «Save to Drive»: in un canale di progetto salva nel progetto; in un DM o in un generale chiede il progetto; senza un progetto adatto il bottone non c'è.
   - Citazioni `doc` con link, citazioni `drive` (R-H5).
   - «Cite in Chat» dal Drive.
5. **Claude** legge le pagine e il Drive (file visibili, non nascosti, con testo). Leggere non conta un'apertura. Claude non carica e non collega file.
6. **Fuori**:
   - versioni dei file, modifica dentro Stubwise, condivisione esterna, cartelle create in Stubwise;
   - funzioni nuove dei Docs;
   - le pagine prodotto dell'area 11;
   - i file del Drive come allegati di posta e nelle automazioni (area 7, R-J18).

## Decisioni (11 nov 2026)

- **D1 = (a)** (M): prima i file caricati; i riferimenti a Google Drive con
  l'area 6 (registro, area 6).
- **D2 = (a)** (O): codici D stabili (`doc_page_codes`), con backfill delle
  citazioni.
- **D3 = (a)** (M): permessi come il prototipo, con la regola dei preset: i
  ruoli che contenevano un preset ricevono i permessi nuovi.
- **D4 = (a)** (M): 100 MB per file. ⚠️ Il proxy del desktop (`api:request`
  del main) ha un tetto per rotta: va allargato anche lì per il caricamento
  del Drive. Lo si dice a stubwise-94 con la F2.
- **D5 = (b)** (M): OCR SUBITO, con un motore nell'immagine del worker (la
  proposta è sotto, «OCR»), con limiti espliciti e fail-open a `no_text` col
  motivo.
- **D6 = (a)** (O): le citazioni di file del repository vanno all'area 10
  (registro, area 10).

## OCR (proposta per la F3, D5 = b)

- **Motore**: Tesseract 5 (`tesseract-ocr`, con `tesseract-ocr-ita` e
  `tesseract-ocr-eng`, i modelli «fast» di Debian), più `poppler-utils`
  (`pdftotext` per i PDF con testo, `pdftoppm` per rasterizzare quelli
  senza). Tutto da apt, sull'immagine di oggi (`node:22-slim`, Debian
  bookworm): nessun servizio nuovo, nessuna rete, nessun modello scaricato
  a runtime. Lo si chiama come processo (`execFile`), con un timeout.
- **Costo sull'immagine** (stima, da misurare al build della F3):
  - `tesseract-ocr` con leptonica, intorno ai 25–30 MB;
  - i due modelli «fast», circa 7 MB;
  - poppler, circa 5–8 MB.
  In tutto 40–50 MB in più sull'immagine del worker. La versione va pinnata
  come il CLI, e un aggiornamento passa dal test di estrazione.
- **Tempi** (stima, da misurare su una fixture nella F3): con i modelli fast
  a 300 dpi, una pagina A4 costa 1–3 secondi su un core. Un PDF con il suo
  testo non passa dall'OCR: `pdftotext` ne estrae il testo in decine di
  millisecondi.
- **Quando**: solo dove il testo non c'è, cioè le immagini (png, jpeg, webp,
  heic se il decoder lo regge) e le pagine di un PDF senza testo estraibile.
  Lingue `ita+eng`.
- **Limiti espliciti**:
  - al più 30 pagine OCR per file (le altre restano fuori, e lo stato lo
    dice: `ready`, con `ocr: partial`);
  - 5 minuti per job di contenuto, poi stop;
  - 60 secondi per pagina;
  - un job alla volta (la coda del contenuto ha concorrenza 1), così l'OCR
    non toglie CPU ai run dell'agente.
- **Fail-open**: un motore assente, un timeout, un file che non si apre o
  un testo vuoto chiudono il file a `no_text`, col motivo (`ocr_timeout`,
  `ocr_unavailable`, `no_text_found`, `unreadable`): il file si trova per
  nome, e «Riprova» lo rimette in coda (con `drive.manage`). Mai `error` per
  l'OCR: `error` resta per i guasti nostri (lo storage, il DB).

## [DECIDE] per l'orchestratrice (com'erano poste)

1. **I riferimenti a Google Drive: quando.** Servono lo scope `drive.readonly` e la cartella collegata, con la sua sincronizzazione. `drive.readonly` è uno scope RISTRETTO di Google:
   - ogni account già collegato (Posta e Calendario) deve riconsentire;
   - per un'app OAuth pubblicata, Google chiede la verifica con una valutazione di sicurezza.
   Il design del prototipo lascia aperta la «struttura del cassetto Google comune a Drive, Posta e Calendario (area 6)».
   - **(a, consigliata)** Il Drive esce in due tempi. Prima i file CARICATI, con contenuto, ricerca, «Save to Drive» e citazioni. Poi i riferimenti Google, insieme all'area 6, che riapre l'account Google e il consenso. Nel frattempo il pannello Google del Drive resta «in arrivo». Così non si chiede un riconsenso due volte.
   - (b) Tutto adesso: lo scope si aggiunge subito, con il riconsenso e, per l'istanza pubblica, la verifica di Google.
2. **Codici `D` stabili delle pagine.**
   - **(a, consigliata)** Una tabella `doc_page_codes (project_id, number, repository_id, slug)`. Il numero è per progetto e non si riusa; la chiave è la coppia repository e slug.
     - Il codice sopravvive alle rigenerazioni finché lo slug resta; una pagina che cambia slug riceve un codice nuovo, e il vecchio si legge «pagina non più disponibile».
     - Le citazioni `doc` della Chat passano al codice: un backfill dalle pagine di oggi, che non hanno ancora rigenerazioni a valle.
   - (b) Niente codici: le citazioni salvano repository e slug. Il «#» e la ricerca non hanno un codice da scrivere, e il prototipo va rivisto.
3. **Permessi del Drive.** Sono tre permessi di progetto nuovi nel registro shared, `drive.upload`, `drive.manage` e `drive.history`, dati anche ai ruoli che contenevano i preset (regola di `permissions.md`).
   - **(a, consigliata)** Come il prototipo:
     - Project Lead: tutti e tre;
     - Developer, Contributor e Legacy Member: `drive.upload`;
     - Viewer: nessuno.
     Vedere il Drive vuol dire essere membri del progetto, Viewer compreso.
   - (b) Come (a), ma senza `drive.upload` per il Legacy Member: è l'assunzione [A 14] dello shape, mai confermata.
4. **Tetto di un file del Drive.**
   - **(a, consigliata)** 100 MB, come il prototipo: il Drive tiene documenti, registrazioni e video, e la Chat resta a 25 MB.
   - (b) 25 MB, come la Chat: una regola sola per i file caricati dalle persone.
   Tipi: l'allowlist della Chat (`CHAT_ATTACHMENT_TYPES`), un elenco per tutti i file di Stubwise. Così «Save to Drive» non trova mai un tipo rifiutato.
5. **Estrazione del contenuto.**
   - **(a, consigliata)** Un job del worker estrae il testo da PDF, testo, markdown, csv e documenti Office/ODF, senza OCR.
     - Immagini e scansioni risultano `no_text`, e si trovano per nome. L'OCR va nel registro.
     - Il riassunto lo scrive Haiku, con un `UsageTag` suo.
     - Gli embedding stanno in una `drive_chunks` accanto a `doc_chunks`.
   - (b) Anche l'OCR subito: un motore OCR nell'immagine del worker, più pesante e da tenere pinnato.
6. **Citazioni di file del repository** (`kind: file`, `<repo>:<path>`, visibili con `repos.view`, senza destinazione). Oggi niente le produce: il «#» non elenca file del repo, e i tool di Claude non leggono il codice.
   - **(a, consigliata)** Rimandarle all'area 10 (Integrazione di Claude), con un tool di lettura del codice. Va nel registro.
   - (b) Adesso, con un tool di sola lettura sui mirror (`:ro` sul server, `repos.view`) e il «#» sui percorsi.

## Il modello (tecnico, mie scelte)

- **Docs** (fetta 1). Nessuna tabella nuova oltre ai codici ([DECIDE] 2).
  - Le rotte di lettura per codice: `GET /api/projects/:projectId/docs/pages/by-code/:code`, che risolve a repository e slug con `docs.view`.
  - La citazione `doc` porta `repositoryId` e `slug`: è un campo in più (additivo), e il desktop costruisce `#/p/<CODE>/docs/<repo>/<slug>`.
  - Gli embedding delle pagine manuali al salvataggio: il server ha già l'embedder delle domande.
  - Le note di rilascio restano solo testo, come oggi.
  - Un tool `read_doc_page` per la chat di Claude, sulla rotta della pagina, aggiunta all'allowlist del turno (`chat-tool-routes.ts`) col test del registro.
  - I metodi mancanti di `@stubwise/api-client`, compreso lo streaming della chat.
- **Drive, file caricati** (fetta 2).
  - Le tabelle:
    - `drive_files`: `id`, `project_id`, `number` (codice F), `source`, `name`, `mime`, `size_bytes`, `storage_key`, `added_by`, `added_at`, `hidden`, `content_state`, `summary`, `text`, `deleted_at`;
    - `drive_opens`: `file_id`, `person_id`, `at`, `via`, con la deduplica di 30 minuti in SQL.
  - Lo storage ha le chiavi `drive/<progetto>/<id>/<nome>`.
  - Le rotte: elenco con filtri e ordinamento, dettaglio, caricamento, eliminazione, apertura (conta), download firmato, storia (`drive.history`).
  - La destinazione globale è un elenco su tutti i progetti di chi guarda.
  - «Save to Drive» copia l'oggetto dell'allegato della Chat in una chiave del Drive, così l'eliminazione del messaggio non tocca il Drive.
  - La citazione `drive` è un valore nuovo di `CHAT_CITATION_KINDS`, con il CHECK della tabella delle citazioni; il «#» elenca i file per nome e codice.
  - I tool di Claude: cercare e leggere il Drive (testo e riassunto), senza contare l'apertura.
- **Contenuto** (fetta 3): una coda `drive_content_jobs` nel worker, che fa estrazione, riassunto ed embedding. La ricerca fonde nome, codice e contenuto, e a pari rilevanza decidono le aperture. In ⌘K il gruppo «Files» va nell'ordine di R-H4.
- **Google** (fetta 4, dopo [DECIDE] 1):
  - i riferimenti, le cartelle collegate, la sincronizzazione nel worker (fuori dal serializer, come il poller Google);
  - «Aggiungi da Google Drive», «Quale progetto?», i file non disponibili con la loro causa.

## Fette

- **F1 — Docs nel desktop.** I codici D, le citazioni con link, la pagina per codice, gli embedding delle manuali, `read_doc_page` per Claude, `api-client`. Test: il codice stabile dopo una rigenerazione, e una citazione che sopravvive; il negativo di `docs.view` (404 su un progetto invisibile, la pagina assente nelle letture trasversali); una manuale trovata dalla ricerca semantica; l'allowlist del turno.
- **F2 — Drive caricato.** Migrazione, permessi, rotte, destinazione globale, «Save to Drive», citazione `drive`, tool di Claude. Test:
  - un nascosto è come uno che non esiste, per elenco, ricerca, «#», codice e Claude;
  - la deduplica delle aperture;
  - la storia solo con `drive.history`;
  - si elimina un proprio file, uno altrui solo con `drive.manage`;
  - «Save to Drive» senza `drive.upload` dà 403;
  - un allegato eliminato in Chat resta nel Drive.
- **F3 — Contenuto e ricerca.** Il job del worker, gli stati, «Riprova», la ricerca per contenuto, la riga del riassunto. Golden: no, il riassunto non decide nulla; un test col runner finto e il `UsageTag`.
- **F4 — Google**, se [DECIDE] 1 = b o con l'area 6.
- Chiusura per fetta: deploy-log (migrazioni; il rollback dei permessi nuovi e dei kind nuovi di citazione), invariante nuova `docs/invariants/drive.md`, registro, parità server, righe di CLAUDE.md per l'orchestratrice.

## Global Constraints

- Chi vede un progetto lo decide `auth/access.ts`. Un progetto invisibile dà 404, e un file o una pagina invisibile non si distingue da uno che non esiste (R-G5), anche nelle letture trasversali.
- Il binario non passa dall'API: caricamento multipart, download firmato con `Content-Disposition: attachment`.
- Le aperture si contano a lettura, ma solo per le azioni della persona (anteprima, apertura in Google, download), mai per Claude.
- Il registro decisioni non si scrive mai dall'AI; i riassunti dei file sono narrativa generata.
- Verso i client solo cambi additivi, con un default per ogni campo nuovo e i kind nuovi dietro `readerSchema`.
- Test filtrati, mutazioni sui test passati al primo colpo, Docker coordinato con stubwise-94.

## Review Focus

- I codici D col giro notturno: una pagina riscritta dal giro tiene lo slug, quindi il codice; una creata dal giro ne prende uno nuovo; la potatura delle generazioni non tocca la tabella dei codici.
- La copia di «Save to Drive»: due oggetti indipendenti nello storage. Eliminare il messaggio non svuota il Drive, eliminare il file del Drive non tocca il messaggio.
- I conteggi del Drive, nell'elenco globale su molti progetti, senza N+1.
