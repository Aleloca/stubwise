# App desktop, area 5: Docs e Drive — piano di implementazione

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Portare nel prototipo `apps/desktop` i Docs del web così come sono,
dentro il progetto, e costruire il Drive nuovo: file caricati e riferimenti
a Google Drive in un elenco unico per progetto, ricerca nel contenuto con
riassunto AI, «più usati» sulle aperture degli ultimi 90 giorni, cartelle
Google collegate, citazioni e lettura da parte di Claude.

**Architecture:** Due blocchi di dati finti, separati come la Chat:
`data/docs/*` (spazi per repository, pagine con codice, generazione,
brief, releases, grafo) e `data/drive/*` (file, riferimenti Google,
aperture, account e cartelle Google simulati, pipeline del contenuto con
stati a ritardo simulato). Visibilità in una sola funzione per blocco; le
pagine leggono solo da `data/queries.ts`. La UI vive in `pages/docs/*` e
`pages/drive/*`; ricerca, ⌘K, citazioni e Claude si estendono nei loro
punti esistenti (`palette/`, `resolveCodes`, `domain/claude/intents/`).

**Tech Stack:** quello delle aree 1–4; nessuna dipendenza nuova (anteprima
PDF con `<iframe>`/`<embed>` su un object URL, immagini con `<img>`,
testo/markdown col renderer Markdown esistente).

**Spec:** `docs/plans/2026-10-25-desktop-area5-docs-drive-design.md`
(approvato 25 ott 2026). Contesto: `apps/desktop/docs/web-inventory.md`
(sezione «Documentation»), design area 4 (R-G5, allegati), area 3
(citazioni, R-E9), `apps/desktop/DESIGN.md`.

## Global Constraints

- Tutte le Global Constraints delle aree 2–4 restano (nessuna rete; en/it con parità; temi; niente monospace salvo logo e codice; codice sempre con nome; colore mai unico segnale; movimento 150–250 ms con reduced-motion; pagine solo via `data/queries.ts`; stati completi; lint/typecheck/test verdi a ogni commit; orologio fisso del prototipo, mai `Date.now()`; Impeccable obbligatorio con gli shape approvati vincolanti).
- **Docs come oggi**: ogni voce «Documentation» dell'inventario web esiste, dentro il progetto (modulo `docs`); nessuna funzione nuova oltre al trasloco, salvo i codici `AUD-D12` e le fonti Drive nella chat.
- **Codici**: file del Drive `<PRJ>-F<n>` (es. `AUD-F7`), un codice per riferimento (un file Google in due progetti → due codici); pagine Docs `<PRJ>-D<n>` (es. `AUD-D12`), stabili al cambio di titolo/percorso. Codice scritto a mano → link se visibile; **nascosto e inesistente identici** (R-G5).
- **Drive**: un elenco per progetto, caricati + Google; nessuna cartella creata in Stubwise; ordinamenti **Più usati** (predefinito), Recenti, Nome; filtri tipo (documento, foglio, presentazione, PDF, immagine, altro), provenienza, chi l'ha aggiunto, «Nascosti».
- **Aperture**: contano anteprima di un caricato, «Apri in Google Drive», download; **non** contano risultati, riassunti, letture di Claude. Stessa persona sullo stesso riferimento entro **30 minuti** = una. «Più usati» e il numero sulla riga = aperture degli **ultimi 90 giorni** («12 negli ultimi 90 giorni»); il totale da sempre nel dettaglio. Numero visibile a chi vede il file; **storico (chi, quando) solo con `drive.history`**.
- **Google**: il contenuto delle cartelle collegate è leggibile da **tutti i membri del progetto**, anche senza accesso su Google (il dialogo di collegamento lo dice); un file di cartella non si toglie, si **nasconde** (`drive.manage`, reversibile, la sincronizzazione non lo rimette); risulta aggiunto da chi ha collegato la cartella. File aperto dalla ricerca fuori dai progetti → apre e chiede il progetto («Non ora» apre senza collegare).
- **Non disponibile** (cancellato su Google o accesso perso): resta in elenco con la causa, si trova **solo per nome**, si può togliere.
- **Permessi nuovi di progetto** (prototipo, `data/viewer.ts`): `drive.upload` (Project Lead, Developer, Contributor), `drive.manage` (Project Lead), `drive.history` (Project Lead). Vedere il Drive = membro del progetto. Ognuno elimina i propri caricati e toglie i Google che ha aggiunto. I permessi Docs restano `docs.view`, `docs.edit`, `docs.generate`, `repos.manage`.
- **Prototipo**: il caricamento legge il file vero (nome, tipo, dimensione) nel renderer e l'anteprima usa un object URL finché l'app resta aperta; testo estratto, OCR, riassunti e reindicizzazione sono finti con ritardo e stati veri; «Apri in Google Drive» non apre il browser (avviso + apertura contata); Google interamente simulato; **nessun lavoro nel processo main**. Limite caricamento **100 MB**; nome uguale → si tengono entrambi, il nuovo con «(2)».
- **Claude** legge il contenuto dei file del Drive dei progetti visibili a chi chiede e li cita; non carica né collega file.

## Review Focus

1. **File di un progetto invisibile o non disponibile** cercato per contenuto, citato con «#», scritto a mano come `AUD-F7`, chiesto a Claude: per chi non vede il progetto è identico a un codice inesistente; un file non disponibile non si trova per contenuto. → test in Task 5, Task 8 e Task 9.
2. **Conteggio delle aperture**: riaperture entro 30′ contano una; un'apertura di 91 giorni fa esce dal numero sulla riga ma resta nel totale; il risultato di ricerca e la lettura di Claude non contano; un file in due progetti conta separato. → test in Task 5.
3. **Cambio di persona** con un file aperto nel dettaglio o un'anteprima: niente della persona precedente (storico, account Google, «a quale progetto?» in sospeso) resta. → test in Task 6 e Task 7.
4. **Nascondere un file di cartella** e risincronizzare: non torna; rimostrarlo lo riporta col suo conteggio. Scollegare la cartella: i suoi file spariscono dal progetto, i caricati restano. → test in Task 5.
5. **Contenuti estremi**: nome di file lunghissimo, 500 file in un progetto, cartella con 200 file, PDF da 99 MB e file da 101 MB, nomi duplicati, riassunto mancante: nessun overflow, elenco reattivo, errori chiari. → test in Task 6.

---

### Task 0 (controller): shape di Impeccable

Brief Impeccable `shape`, approvati dal maintainer, in `apps/desktop/.impeccable/shape/`: `docs.md` (Docs del progetto: pagina iniziale con chat, spazio del repository con albero e pannello di generazione, pagina, form pagina manuale, brief, releases, grafo, chat del repository, ricerca ⌘K scoped), `drive.md` (Drive del progetto e destinazione sul binario: elenco con gruppi delle cartelle, filtri e ordinamenti, riga, dettaglio con anteprima/scheda, caricamento, stati del contenuto), `drive-google.md` (account Google personale, collegare/scollegare una cartella con l'avviso di leggibilità, «Aggiungi da Google Drive», «a quale progetto?», non disponibile, collegamento scaduto, nascosti, storico delle aperture), `drive-search.md` (ricerca nel Drive con passaggio evidenziato e riassunto, gruppo File di ⌘K, file fuori dai progetti, citazione «#» di un file). Nessun codice.

### Task 1: Docs — modello, codici, seme e livello dati

**Files:** Modify `data/model.ts`, `data/seed/docPages.ts`, `data/api.ts`, `data/api-mutations.ts`, `data/queries.ts`, `data/store.ts`; Create `data/seed/docs/*.ts`, `data/docs/{reads.ts,writes.ts}` (+`data/docs/docs.test.ts`).

**Interfaces — Produces (`model.ts`):**
```ts
export type DocKind = "technical" | "functional" | "product" | "manual";
export interface DocPage { id: string; code: string /* AUD-D12 */; projectId: string; repositoryId: string; kind: DocKind;
  title: string; slug: string; path: string; excerpt: string; body: string /* markdown */; documentsPath: string | null;
  generatedAtCommit: string | null; updatedAt: string; staleCommits: { sha: string; message: string; at: string }[];
  links: { type: "implements" | "implemented_by" | "related"; pageId: string }[]; views: number }
export interface DocSpace { repositoryId: string; projectId: string; name: string; generation: DocGeneration;
  brief: RepoBrief | null; releases: DocRelease[]; graph: GraphState }
export interface DocGeneration { status: "never" | "queued" | "running" | "succeeded" | "failed" | "held" | "paused";
  lastAt: string | null; commit: string | null; costUsd: number | null; provider: string | null; reason: string | null }
export type GraphState = { status: "disabled" | "never" | "queued" | "running" | "failed" | "ready"; reason?: string;
  nodes?: number; edges?: number; communities?: number; setupPr?: { url: string; open: boolean } }
```
`RepoBrief` (identità, attori, superfici, glossario, invarianti, percorsi, fonti, fatti riservati, pagine escluse) e `DocRelease` (versione, data, testo, `minor`, pagine toccate) seguono l'inventario web righe 429–465.
- Reads: `listDocSpaces(projectId)`, `getDocSpace(repositoryId)`, `listDocTree(repositoryId)`, `getDocPage(repositoryId, slug)`, `getProjectDocsHome(projectId)` (brief, inizia da qui, spazi, sintesi decisioni, novità), `searchDocs(q, { repositoryId? })`.
- Writes: `createManualPage`, `updateManualPage`, `deleteManualPage` (`docs.edit`; conflitto di slug → `slug_conflict`), `startGeneration`, `resumeGeneration` (`docs.generate`; stati avanzano col ritardo simulato via `gate()`), `graphAction(kind: "generate" | "regenerate" | "rebuild" | "setup_pr")` (`repos.manage`), `recordDocView(pageId)` (alimenta «più lette», nessun legame col Drive).
- Codici: ogni pagina esistente del seme riceve un `code` stabile; `resolveCodes` riconosce `<PRJ>-D<n>` con R-G5.
- [ ] Tests: AUD e STW con spazi, albero nelle quattro categorie, una pagina manuale, una pagina vecchia con commit successivi, collegamenti; STW grafo pronto, AUD spento; una generazione in pausa per limite; progetto senza modulo docs → `listDocSpaces` vuoto e sezione assente; `docs.view` mancante → `forbidden`; slug in conflitto; transizioni di generazione; `resolveCodes(["AUD-D3"])` per chi non vede AUD = come `["AUD-D999"]`.
- [ ] Commit `feat(desktop): dati dei Docs`.

### Task 2: Docs — pagina iniziale, spazio, pagina e pagina manuale

**Files:** Create `pages/docs/{DocsHome.tsx,DocSpace.tsx,DocTree.tsx,DocPageView.tsx,ManualPageForm.tsx}` (+test); Modify `router.tsx` (sezione `docs` e sottorotte `/p/$code/docs`, `/p/$code/docs/$repo`, `/p/$code/docs/$repo/$slug`, `/new`, `/$slug/edit`), i18n en/it.

Pagina iniziale (senza chat: Task 3), spazio con barra secondaria e albero ridimensionabile (comprimi/espandi, scarica categoria → file `.zip` finto con avviso), indice del repository (brief, inizia da qui, categorie, novità, aggiornate di recente, più lette), pagina (badge, avviso pagina vecchia, collegamenti, modifica/eliminazione manuale con conferma), form manuale (conflitto di slug), pagina non trovata. Shape `docs.md` vincolante.
- [ ] Tests: navigazione albero → pagina; `recordDocView` alla visita; manuale creata/modificata/eliminata con `docs.edit`, azioni assenti senza; pagina vecchia mostra i commit; cambio di persona sulla pagina; stati caricamento/errore/vuoto.
- [ ] Commit `feat(desktop): Docs del progetto`.

### Task 3: Docs — generazione, brief, releases, grafo, chat, ricerca

**Files:** Create `pages/docs/{GenerationPanel.tsx,RepoBrief.tsx,DocReleases.tsx,DocGraph.tsx,DocsChat.tsx}` (+test); Modify `palette/CommandPalette.tsx` (scope «Questa documentazione»/«Tutto» con Tab dentro uno spazio Docs), `domain/claude/intents/howto.ts` se serve per le fonti.

Pannello di generazione con tutti gli stati e azioni (`docs.generate`); brief (sezioni, fatti riservati, pagine escluse, vuoto/errore); releases (ricerca, «Solo significative», badge minor, pagine toccate); grafo (stati, conteggi, «Abilitalo nel repository» per `repos.manage`/«chiedi a un maintainer» per gli altri, azioni, `graph.json` finto, comando copiabile); chat del progetto e del repository riusando i pezzi della conversazione dell'area 3 (Markdown, citazioni R-E9, domande suggerite, nuova chat, stato «chat non disponibile»), con risposte dal motore di intenti che citano pagine Docs per codice.
- [ ] Tests: ogni stato di generazione e grafo; azioni assenti senza permesso; releases filtra; chat risponde citando una pagina `AUD-D…`; ⌘K in uno spazio cerca solo lì e Tab allarga.
- [ ] Commit `feat(desktop): generazione, brief, releases, grafo e chat dei Docs`.

### Task 4: Drive — modello, permessi e seme

**Files:** Modify `data/model.ts`, `data/viewer.ts` (+test); Create `data/seed/drive/*.ts`; Test `data/seed.test.ts`.

**Interfaces — Produces (`model.ts`):**
```ts
export type DriveFileType = "document" | "sheet" | "slides" | "pdf" | "image" | "other";
export type ContentState = "processing" | "ready" | "no_text" | "unsupported" | "error";
export interface DriveFile { id: string; code: string /* AUD-F7 */; projectId: string; source: "upload" | "google";
  name: string; type: DriveFileType; mime: string; sizeBytes: number | null; addedById: string; addedAt: string;
  modifiedAt: string; folderLinkId: string | null; googleFileId: string | null; googleOwner: string | null;
  hidden: boolean; unavailable: null | "deleted" | "access_lost"; content: ContentState; text: string; summary: string | null;
  ocr: boolean }
export interface DriveOpen { fileId: string; personId: string; at: string; via: "preview" | "google" | "download" }
export interface GoogleAccount { personId: string; email: string; status: "connected" | "expired" }
export interface FolderLink { id: string; projectId: string; name: string; googleFolderId: string; linkedById: string;
  linkedAt: string; status: "ok" | "expired" }
export interface GoogleOutsideFile { googleFileId: string; name: string; type: DriveFileType; visibleToPersonIds: string[]; text: string; summary: string }
```
`viewer.ts`: `drive.upload`, `drive.manage`, `drive.history` con i preset delle Global Constraints.
- [ ] Tests (seme): AUD con cartella collegata «AUD – Cliente» (contratto, preventivo foglio, presentazione) + caricati (PDF di specifiche, mockup immagini, uno `.zip`); MKX con molti file grafici e una cartella; un progetto senza file; aperture distribuite su >90 giorni con file molto usati e mai aperti; un Google non disponibile, uno in `processing`, un PDF con `ocr: true`, un'immagine `no_text`; un `GoogleOutsideFile` visibile solo a chi ha l'account; persone con e senza account (una `expired`); un contratto il cui testo risponde a «tempi di consegna»; codici unici per progetto. Viewer per i tre permessi.
- [ ] Commit `feat(desktop): modello e seme del Drive`.

### Task 5: Drive — livello dati

**Files:** Create `data/drive/{visibility.ts,reads.ts,writes.ts,content.ts}` (+`data/drive/drive.test.ts`); Modify `data/api.ts`, `data/api-mutations.ts`, `data/queries.ts`, `data/store.ts`.

**Interfaces — Produces:**
- `canSeeDriveFile(me, file)` (membro del progetto, non nascosto salvo filtro «Nascosti» con `drive.manage`); unica fonte per ogni lettura.
- Reads: `listDriveFiles({ projectId?, type?, source?, addedById?, hidden?, sort: "most_used" | "recent" | "name" })` → righe con `opens90d`, prima riga del riassunto, gruppo cartella; `getDriveFile(id)` → anche `opensTotal`, `history` **solo con `drive.history`** (altrimenti `null`); `listFolderLinks(projectId)`; `getGoogleAccount()`; `listGoogleOutside(q)` (solo con account `connected`).
- Writes: `uploadFiles(projectId, files: { name, mime, sizeBytes }[])` (`drive.upload`; >100 MB → `too_large`; nome uguale → «(2)»; contenuto `processing` → stato finale dopo il ritardo), `deleteDriveFile(id)` (proprio, o `drive.manage`), `removeGoogleFile(id)` (aggiunto da me, o `drive.manage`; vietato per file di cartella → `use_hide`), `setHidden(id, hidden)` (`drive.manage`), `linkFolder(projectId, googleFolderId)` / `unlinkFolder(linkId)` (`drive.manage`), `addGoogleFile(projectId, googleFileId)` (`drive.upload`), `recordOpen(fileId, via)` (dedup 30′ per persona e riferimento), `retryExtraction(id)` (`drive.manage`), `connectGoogle()` / `disconnectGoogle()`, `syncFolder(linkId)` (rispetta i nascosti; un file del seme «aggiornato su Google» torna `processing` col riassunto in rielaborazione, poi `ready`).
- `content.ts`: `opens90d(file, now)`, `isOpenCounted(prev, next)`; il ritardo simulato passa da `gate()`.
- [ ] Tests: Review Focus 1, 2, 4 (codici e righe); storico `null` senza `drive.history`; non disponibile cercabile solo per nome; `too_large`; duplicato «(2)»; scollegare una cartella toglie i suoi file e lascia i caricati; account `expired` → `listGoogleOutside` vuoto; letture di Claude non chiamano `recordOpen`.
- [ ] Commit `feat(desktop): dati del Drive`.

### Task 6: Drive — elenco, dettaglio, anteprima e caricamento

**Files:** Create `pages/drive/{DrivePage.tsx,DriveList.tsx,DriveRow.tsx,DriveDetail.tsx,FilePreview.tsx,UploadZone.tsx,driveFilters.ts}` (+test); Modify `router.tsx` (sezione progetto `drive` e destinazione `/drive` aggiunta a `APP_ROUTES` e al binario `layout/Rail.tsx`), i18n en/it.

Elenco con gruppi richiudibili delle cartelle in testa, filtri e ordinamenti nell'URL, riga (icona tipo, nome, provenienza, autore, modifica, «N negli ultimi 90 giorni», prima riga del riassunto); dettaglio a destra come quello della task (anteprima di immagine/PDF/testo via object URL per i caricati della sessione, anteprima finta dopo il riavvio, scheda per Google; riassunto intero, totale aperture, storico con permesso, azioni del design); caricamento con trascinamento e selettore (File API vera, avanzamento, `too_large`, «Riprova»); stati del contenuto; destinazione globale con filtro progetto, una riga per riferimento.
- [ ] Tests: Review Focus 3 (dettaglio aperto + cambio persona) e 5 (500 file, nome lungo, 101 MB, duplicati, riassunto mancante); aprire l'anteprima conta un'apertura, riaprire subito no; azioni secondo permesso; filtri e ordinamento nell'URL.
- [ ] Commit `feat(desktop): Drive del progetto`.

### Task 7: Drive — Google

**Files:** Create `pages/drive/{GoogleAccountCard.tsx,LinkFolderDialog.tsx,AddFromGoogleDialog.tsx,WhichProjectDialog.tsx,DriveBanners.tsx}` (+test); Modify il menu profilo (`layout/ProfileMenu.tsx`) con «Account Google» che apre la scheda account.

Account Google personale (collega/scollega, scaduto), collegare una cartella con l'avviso «tutti i membri del progetto potranno leggerne il contenuto» e scollegarla, «Aggiungi da Google Drive», «a quale progetto?» (progetti dove hai `drive.upload`; «Non ora»), «Apri in Google Drive» (avviso + apertura contata), file non disponibile con causa e «Togli», collegamento scaduto con «Ricollega» per `drive.manage`, nascondi/rimostra e filtro «Nascosti».
- [ ] Tests: collegare una cartella porta i suoi file; nascondere + `syncFolder` non lo rimette; «a quale progetto?» con e senza progetti idonei; cambio di persona con il dialogo aperto lo chiude; senza account la ricerca invita a collegarlo.
- [ ] Commit `feat(desktop): Google Drive nel Drive`.

### Task 8: Ricerca nel Drive e da ⌘K

**Files:** Modify `data/drive/reads.ts` (`searchDrive`), `palette/CommandPalette.tsx` (gruppo **File**), `pages/drive/*` (campo di ricerca e risultati) (+test).

`searchDrive(q, { projectId? })` → risultati per nome e contenuto (passaggio con l'evidenziazione della ricerca della Chat, riusando `highlightParts`), riassunto, progetto, `opens90d`; a parità di pertinenza pesa `opens90d`; file `processing`/non disponibili solo per nome; file Google fuori dai progetti (account collegato) in coda, «Apri» → «a quale progetto?». ⌘K: gruppo File dopo gli oggetti esatti, prima di Canali/Messaggi; le righe di ripiego restano in «Altro».
- [ ] Tests: Review Focus 1 (ricerca); un risultato aperto conta, mostrarlo no; pertinenza a pari punteggio ordinata per `opens90d`; Enter su un comando in ⌘K esegue ancora il comando.
- [ ] Commit `feat(desktop): ricerca nei file del Drive`.

### Task 9: Citazioni, Claude e allegati

**Files:** Modify `data/model.ts` (`CitationRef.kind` + `"drive"`), `data/api.ts` (`resolveCodes`, `searchMentions` per «#»), citazioni della conversazione (anteprima di un file: nome, tipo, progetto, riassunto), `domain/claude/intents/*` (risposte che leggono i file del Drive), `pages/chat/*` (azione «Salva nel Drive» sull'allegato) (+test).

Citazione `drive` con R-E9; «#» trova file del Drive visibili; codici `AUD-F7` scritti a mano con R-G5; Claude (destinazione, task, @Claude) risponde a «cosa dice il contratto col cliente sui tempi di consegna» citando il contratto di AUD, solo per chi vede AUD, senza contare aperture; le chat dei Docs possono citare file del Drive; «Salva nel Drive» in un canale di progetto salva lì, in DM/generale chiede il progetto fra quelli con `drive.upload` (nessuno → azione assente).
- [ ] Tests: Review Focus 1 (citazione, codice, Claude); lettura di Claude non conta un'apertura; «Salva nel Drive» nei tre casi.
- [ ] Commit `feat(desktop): citazioni del Drive e Claude nei file`.

### Task 10: Parità, screenshot, follow-up

`apps/desktop/docs/area5-parity.md`: ogni voce «Documentation» dell'inventario → dove vive e il test; voci Drive nuove (senza parità); buchi se ce ne sono. Chiude in `area4-parity.md`/follow-ups la decisione aperta sugli allegati. `capture.mjs`: scatti `a5-*` (pagina iniziale Docs, pagina, grafo, Drive di AUD, dettaglio con storico, collegare cartella, «a quale progetto?», ricerca nel Drive, Claude che cita un file) light/dark, en/it a 1440 e uno a 1024; vite ucciso. «Area 5 — minori aperti» in `ossatura-follow-ups.md`. Suite, typecheck, lint, build verdi. Commit `docs(desktop): parità dell'area 5`.

Dopo il Task 10: revisione finale del branch (area 5) e revisione visiva di Impeccable.
